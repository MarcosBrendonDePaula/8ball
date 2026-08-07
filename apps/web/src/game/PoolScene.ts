import { GameLoop } from './core/loop'
import { Scene } from './core/scene'
import { BallsObject } from './objects/BallsObject'
import { CueObject } from './objects/CueObject'
import { HudObject } from './objects/HudObject'
import { MatchController } from './objects/MatchController'
import { TableObject } from './objects/TableObject'
import { fixed as F, table as T } from '@zinc-pool/engine-physics'
import type { GameModeId } from '@zinc-pool/engine-rules'

/**
 * Monta a cena da partida.
 *
 * Equivalente a montar a hierarquia de uma cena da Unity: cria os objetos,
 * define a ordem de desenho e liga o laço. Toda a lógica vive nos objetos;
 * aqui só se decide quem existe.
 *
 * A ordem de desenho é explícita em cada objeto (`order`) em vez de depender
 * da ordem de criação — assim acrescentar um objeto no meio da lista não
 * reordena o que já funcionava.
 */
export type PoolSceneHandle = {
  loop: GameLoop
  match: MatchController
  dispose(): void
}

export function createPoolScene(
  canvas: HTMLCanvasElement,
  modeId: GameModeId,
  /** Número em hotseat; os 32 bytes do commit-reveal numa mesa em rede. */
  seed: number | Uint8Array = 1,
): PoolSceneHandle {
  const scene = new Scene()

  const match = scene.add(new MatchController(modeId, seed))
  scene.add(new TableObject())
  scene.add(new BallsObject(match))
  scene.add(new CueObject(match))
  scene.add(new HudObject(match))

  // O passo fixo é o MESMO da engine. Divergir aqui faria o cliente simular
  // uma física diferente da do servidor, e a predição local perderia o
  // sentido — o jogador veria uma tacada e receberia outra.
  const loop = new GameLoop(canvas, scene, F.toNumber(T.DT))
  loop.start()

  return {
    loop,
    match,
    dispose: () => loop.dispose(),
  }
}
