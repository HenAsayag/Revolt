"""
Convert the Bloomfield 2019 .blend into game assets.

    blender -b Bloomfield_2019.blend --python tools/export_blend.py -- <out_dir>

Writes to <out_dir>:
  bloomfield.glb            visual meshes, joined per material, Draco-compressed
  bloomfield_collision.glb  stand concrete / aisles / rails for Rapier trimeshes (no materials)
  seats.bin                 one record per seat shell (replaced in-game by an InstancedMesh):
                            u32 count, then count × f32[x, y, z, theta], then count × u8 colour
and tools/stadium_info.json: aisle bounding boxes + stand height profiles (for track design)

Coordinates are converted to the game frame: the model is turned -90° about Blender Z so the
pitch's long axis runs along game +X; glTF's Y-up conversion then gives game (x, y, z) =
(bx, bz, -by). The West main stand ends up at game z < 0, the East stand at z > 0.
"""
import bpy, bmesh, math, json, os, sys
import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else os.path.join(os.path.dirname(__file__), '..', 'public', 'models'))
os.makedirs(OUT, exist_ok=True)
scene = bpy.context.scene
vl = bpy.context.view_layer

SEAT_PALETTE = ['Seat | muted violet', 'Seat | warm light gray', 'Seat | medium gray', 'Seat | graphite']
DROP_TYPES = {'CAMERA', 'LIGHT', 'FONT'}
DROP_NAMES = ['seat shells', 'seat pedestals', 'Pitch turf', 'Regulation pitch markings', 'perimeter panels']
COLLISION_NAMES = ['risers and treads', 'aisle stairs', 'guard and handrails', 'Open circulation decks',
                   'stepped VIP galleries', 'gallery glazing', 'Entrance gates', 'external columns']


def to_game(v):
    """Rotated Blender coords → game coords (glTF Y-up)."""
    return [float(v[0]), float(v[2]), float(-v[1])]


# --- 0. Turn the whole model so the pitch runs along X.
R = Matrix.Rotation(-math.pi / 2, 4, 'Z')
for o in scene.objects:
    if o.parent is None:
        o.matrix_world = R @ o.matrix_world
vl.update()

# --- 1. Seats → compact records.
def extract_seats():
    xs, cols = [], []
    sizes = []
    for o in [o for o in scene.objects if o.type == 'MESH' and 'seat shells' in o.name]:
        me = o.data
        n = len(me.vertices)
        co = np.empty(n * 3, np.float64); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
        M = np.array(o.matrix_world)
        co = co @ M[:3, :3].T + M[:3, 3]
        ev = np.empty(len(me.edges) * 2, np.int64); me.edges.foreach_get('vertices', ev); ev = ev.reshape(-1, 2)
        lab = np.arange(n)
        while True:  # connected components by min-label propagation + pointer jumping
            a, b = lab[ev[:, 0]], lab[ev[:, 1]]
            m = np.minimum(a, b)
            if not ((a != m) | (b != m)).any():
                break
            np.minimum.at(lab, ev[:, 0], m); np.minimum.at(lab, ev[:, 1], m)
            for _ in range(4):
                lab = lab[lab]
        uniq, inv = np.unique(lab, return_inverse=True)
        k = len(uniq)
        cnt = np.bincount(inv, minlength=k).astype(np.float64)
        cen = np.stack([np.bincount(inv, co[:, i], k) / cnt for i in range(3)], 1)
        zmin = np.full(k, 1e9); zmax = np.full(k, -1e9)
        np.minimum.at(zmin, inv, co[:, 2]); np.maximum.at(zmax, inv, co[:, 2])
        # Each seat is two loose parts: a flat pan (~5 cm tall) and a backrest behind/above it.
        is_pan = (zmax - zmin) < 0.1
        pans = np.nonzero(is_pan)[0]
        backs = np.nonzero(~is_pan)[0]
        from mathutils.kdtree import KDTree
        kd = KDTree(len(backs))
        for j, bi in enumerate(backs):
            kd.insert(Vector(cen[bi]), j)
        kd.balance()
        fwd = np.zeros((k, 2))
        for pi in pans:
            (bco, j, dist) = kd.find(Vector(cen[pi]))
            v = cen[pi, :2] - np.array(bco[:2])
            fwd[pi] = v / max(1e-6, np.linalg.norm(v))
        sizes.append((o.name, 'pans', int(len(pans))))
        sizes.append((o.name, 'backs', int(len(backs))))
        # Material per seat.
        nf = len(me.polygons)
        mi = np.empty(nf, np.int64); me.polygons.foreach_get('material_index', mi)
        ls = np.empty(nf, np.int64); me.polygons.foreach_get('loop_start', ls)
        lv = np.empty(len(me.loops), np.int64); me.loops.foreach_get('vertex_index', lv)
        slot_to_pal = [SEAT_PALETTE.index(s.material.name) if s.material and s.material.name in SEAT_PALETTE else 0 for s in o.material_slots]
        seat_mat = np.zeros(k, np.int64)
        seat_mat[inv[lv[ls]]] = np.array(slot_to_pal)[mi] if len(slot_to_pal) else 0
        for i in pans:
            g = to_game(cen[i])
            # game forward (fx, 0, fz) = (bfx, 0, -bfy); seat mesh faces local -Z
            fx3, fz3 = fwd[i, 0], -fwd[i, 1]
            theta = math.atan2(-fx3, -fz3)
            xs.append((g[0], g[1], g[2], theta))
            cols.append(int(seat_mat[i]))
        print('seats', o.name, k)
    arr = np.array(xs, np.float32)
    with open(os.path.join(OUT, 'seats.bin'), 'wb') as fh:
        fh.write(np.array([len(xs)], np.uint32).tobytes())
        fh.write(arr.tobytes())
        fh.write(np.array(cols, np.uint8).tobytes())
    print('SEATS TOTAL', len(xs))
    for s in sizes[:12]:
        print('  size', s)
    return len(xs)

seat_count = extract_seats()

# --- 2. Material tweaks: emissive floodlight lamps, UVs on the LED screens.
lamp_mat = bpy.data.materials.new('Floodlight lamp')
for o in scene.objects:
    if o.type == 'MESH' and 'catwalk and lamps' in o.name:
        names = [s.material.name if s.material else '' for s in o.material_slots]
        if 'Seat | warm light gray' in names:
            o.data.materials.append(lamp_mat)
            src = names.index('Seat | warm light gray')
            dst = len(o.data.materials) - 1
            for p in o.data.polygons:
                if p.material_index == src:
                    p.material_index = dst

for o in scene.objects:
    if o.type == 'MESH' and 'LED screens' in o.name:
        me = o.data
        names = [s.material.name if s.material else '' for s in o.material_slots]
        if 'Screen | inactive black' not in names:
            continue
        si = names.index('Screen | inactive black')
        bm = bmesh.new(); bm.from_mesh(me)
        uv = bm.loops.layers.uv.verify()
        Mw = o.matrix_world
        for f in bm.faces:
            if f.material_index != si:
                continue
            n = (Mw.to_3x3() @ f.normal).normalized()
            axis = n.cross(Vector((0, 0, 1)))
            if axis.length < 1e-3:
                continue
            axis.normalize()
            pts = [Mw @ l.vert.co for l in f.loops]
            us = [p.dot(axis) for p in pts]; zs = [p.z for p in pts]
            u0, u1, z0, z1 = min(us), max(us), min(zs), max(zs)
            for l, p in zip(f.loops, pts):
                l[uv].uv = ((p.dot(axis) - u0) / max(1e-6, u1 - u0), (p.z - z0) / max(1e-6, z1 - z0))
        bm.to_mesh(me); bm.free()
        print('screen UVs on', o.name)

# --- 3. Drop what the game replaces.
for o in list(scene.objects):
    if o.type in DROP_TYPES or (o.type == 'MESH' and any(k in o.name for k in DROP_NAMES)):
        bpy.data.objects.remove(o, do_unlink=True)
vl.update()

# --- 4. Survey for track design: aisle boxes + stand height profiles (game coords).
info = {'seat_count': seat_count, 'aisles': [], 'profiles': {}}
dg = bpy.context.evaluated_depsgraph_get()
for o in scene.objects:
    if o.type != 'MESH' or 'aisle stairs' not in o.name:
        continue
    me = o.data
    bm = bmesh.new(); bm.from_mesh(me); bm.transform(o.matrix_world)
    bm.verts.ensure_lookup_table()
    seen = set()
    for v in bm.verts:
        if v.index in seen:
            continue
        stack = [v]; comp = []
        seen.add(v.index)
        while stack:
            w = stack.pop(); comp.append(w.co.copy())
            for e in w.link_edges:
                u = e.other_vert(w)
                if u.index not in seen:
                    seen.add(u.index); stack.append(u)
        mn = [min(c[i] for c in comp) for i in range(3)]
        mx = [max(c[i] for c in comp) for i in range(3)]
        a, b = to_game(mn), to_game(mx)
        info['aisles'].append({'obj': o.name, 'min': [a[0], a[1], min(a[2], b[2])], 'max': [b[0], b[1], max(a[2], b[2])], 'verts': len(comp)})
    bm.free()

def profile(name, p0, p1, step=0.25):
    """Ray-cast straight down along a line given in game (x, z)."""
    out = []
    L = math.dist(p0, p1)
    n = int(L / step)
    for i in range(n + 1):
        t = i / n
        gx = p0[0] + (p1[0] - p0[0]) * t; gz = p0[1] + (p1[1] - p0[1]) * t
        hit, loc, nrm, idx, obj, mat = scene.ray_cast(dg, Vector((gx, -gz, 80)), Vector((0, 0, -1)))
        out.append([round(gx, 2), round(gz, 2), round(loc.z, 3) if hit else None, obj.name[:40] if hit else None])
    info['profiles'][name] = out

profile('west_x0', (0, -34), (0, -84))
profile('east_x0', (0, 34), (0, 84))
profile('north_z0', (52, 0), (86, 0))
profile('south_z0', (-52, 0), (-86, 0))
profile('west_x20', (20, -34), (20, -84))
profile('east_x20', (20, 34), (20, 84))
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'stadium_info.json'), 'w') as fh:
    json.dump(info, fh)
print('aisles', len(info['aisles']))

# --- 5. Collision GLB.
bpy.ops.object.select_all(action='DESELECT')
col_objs = [o for o in scene.objects if o.type == 'MESH' and any(k in o.name for k in COLLISION_NAMES)]
for o in col_objs:
    o.select_set(True)
vl.objects.active = col_objs[0]
bpy.ops.export_scene.gltf(
    filepath=os.path.join(OUT, 'bloomfield_collision.glb'), export_format='GLB', use_selection=True,
    export_materials='NONE', export_normals=False, export_texcoords=False, export_apply=True,
    export_draco_mesh_compression_enable=True, export_draco_position_quantization=16,
)
print('collision objects', [o.name for o in col_objs])

# --- 6. Visual GLB: split every mesh by material, then join per (stand region, material) — few
# draw calls, but still split spatially so frustum culling (incl. the shadow pass) can skip stands.
def region(name):
    head = name.split(' | ')[0].split('.')[0].strip()
    head = {'WEST main stand': 'West', 'EAST exposed steel': 'East'}.get(head, head)
    return head if head in ('East', 'NE', 'North', 'NW', 'West', 'SW', 'South', 'SE') else 'Misc'

meshes = [o for o in scene.objects if o.type == 'MESH']
for o in meshes:
    if len(o.data.materials) <= 1:
        continue
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True); vl.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.separate(type='MATERIAL')
    bpy.ops.object.mode_set(mode='OBJECT')
groups = {}
for o in scene.objects:
    if o.type != 'MESH' or len(o.data.polygons) == 0:
        continue
    used = {o.material_slots[p.material_index].material.name if o.material_slots and o.material_slots[p.material_index].material else 'none' for p in o.data.polygons}
    key = region(o.name) + '__' + sorted(used)[0]
    groups.setdefault(key, []).append(o)
for key, objs in groups.items():
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    vl.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    vl.objects.active.name = 'M_' + key
print('material groups', sorted(groups.keys()))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(
    filepath=os.path.join(OUT, 'bloomfield.glb'), export_format='GLB', use_selection=True,
    export_apply=True, export_texcoords=True, export_normals=True,
    export_draco_mesh_compression_enable=True, export_draco_position_quantization=16,
)
print('DONE', OUT)
