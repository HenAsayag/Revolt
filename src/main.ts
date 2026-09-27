import './style.css';
import { Game } from './game/Game';
import { initPhysics } from './physics/Physics';
import { loadStadiumAssets } from './world/stadium/StadiumModel';

async function boot() {
  const loading = document.getElementById('loading');
  const [, assets] = await Promise.all([
    initPhysics(),
    loadStadiumAssets((f) => {
      if (loading) loading.textContent = `Loading Bloomfield… ${Math.round(f * 100)}%`;
    }),
  ]);
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const game = new Game(canvas, document.getElementById('hud')!, assets);
  document.getElementById('loading')?.remove();
  game.start();
  // Handy for poking at the game from the dev console / automated checks.
  (window as unknown as { __rc: Game }).__rc = game;
  if (import.meta.env.DEV) import('./dev/devTools').then((m) => m.installDevTools(game));
  // Never leave an old game loop running after a hot update.
  import.meta.hot?.dispose(() => game.dispose());
}

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) el.textContent = `Failed to start: ${err instanceof Error ? err.message : err}`;
});
