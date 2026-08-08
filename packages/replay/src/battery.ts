import { DEFAULT_CUE, CUE_ARCHETYPES, ENGINE_VERSION } from '@zinc-pool/engine-physics'
import type { GameModeId } from '@zinc-pool/engine-rules'
import { encodeAngle, encodePower, encodeSpin, REPLAY_VERSION, type Replay } from './format'
import { verifyReplay } from './verify'

/**
 * Bateria de REPLAYS de referência.
 *
 * A bateria da engine-physics prova que a mesa evolui igual em toda plataforma.
 * Isso é a base, mas não é a promessa: a promessa é que o REPLAY aponta o mesmo
 * VENCEDOR em qualquer lugar. Entre uma coisa e outra existe a camada de
 * regras — falta, bola na mão, alternância de turno, fim de partida —, e nada
 * verificava que ela também concorda entre navegadores.
 *
 * A distância importa. A física é aritmética de ponto fixo, que já foi feita
 * para não depender de `Math`. As regras decidem QUEM GANHA, e uma divergência
 * ali não muda um hash de mesa: muda o dono do pote.
 *
 * Assim como a outra, esta bateria não usa aleatoriedade — os parâmetros saem
 * de uma sequência aritmética, então ela é idêntica em qualquer lugar.
 */

export type ReplayFixture = {
  name: string
  mode: GameModeId
  seedByte: number
  shots: { angleDeg: number; power: number; spinX: number; spinY: number }[]
}

const MODOS: readonly GameModeId[] = ['eightball', 'sinuca']

/**
 * Tamanho da bateria, dimensionado por MEDIÇÃO do custo.
 *
 * A bateria roda no navegador do jogador, e uma que demora dois minutos não é
 * rodada por ninguém — vira uma verificação que existe no papel.
 *
 * Medido: uma partida de 8-Ball de 40 tacadas custa ~0,6s; uma de sinuca de 74
 * custa ~12s. A sinuca simula 22 bolas contra 15, e o custo por tacada cresce
 * com o número de colisões possíveis. Oito de cada, como estava, davam 93
 * segundos, dos quais 87 eram sinuca.
 *
 * O corte é na sinuca, e o que se perde é declarado: com tacadas de sequência
 * aritmética ela não termina nem em 74 tacadas, então encurtar não custa nenhum
 * vencedor decidido — custa profundidade de mesa, que 4 partidas de 24 tacadas
 * ainda dão.
 */
const CONFIG: Record<GameModeId, { partidas: number; tacadas: number }> = {
  eightball: { partidas: 8, tacadas: 40 },
  sinuca: { partidas: 4, tacadas: 24 },
}

/** 12 partidas: 8 de 8-Ball, 4 de sinuca. */
export const REPLAY_FIXTURES: readonly ReplayFixture[] = MODOS.flatMap((mode, m) =>
  Array.from({ length: CONFIG[mode].partidas }, (_, i) => ({
    name: `${mode}-${i.toString().padStart(2, '0')}`,
    mode,
    seedByte: (m * 97 + i * 31 + 5) % 256,
    shots: Array.from({ length: CONFIG[mode].tacadas }, (_, j) => ({
      angleDeg: (m * 113 + i * 59 + j * 67) % 360,
      power: 0.3 + ((m * 17 + i * 23 + j * 41) % 71) / 100,
      spinX: (((i * 19 + j * 13) % 21) - 10) / 10,
      spinY: (((i * 37 + j * 7) % 21) - 10) / 10,
    })),
  })),
)

/** Monta o `Replay` de uma fixture. Sem I/O, sem relógio, sem aleatório. */
export function buildReplayFixture(f: ReplayFixture): Replay {
  return {
    version: REPLAY_VERSION,
    mode: f.mode,
    engineVersion: ENGINE_VERSION,
    seed: new Uint8Array(32).fill(f.seedByte),
    // Tacos diferentes de propósito: os atributos entram na física, e usar o
    // mesmo dos dois lados esconderia uma divergência que só aparece com eles.
    cues: [DEFAULT_CUE, CUE_ARCHETYPES.pesado],
    shots: f.shots.map((s) => ({
      angle: encodeAngle((s.angleDeg * Math.PI) / 180),
      power: encodePower(s.power),
      spinX: encodeSpin(s.spinX),
      spinY: encodeSpin(s.spinY),
    })),
    /*
     * Posições e declarações em quantidade, de propósito.
     *
     * Sem elas a bateria não media nada: a primeira falta abre bola na mão, o
     * verificador não acha a posição gravada e PARA. Quinze das dezesseis
     * partidas terminavam na tacada 1, sem vencedor — a bateria passava em toda
     * plataforma porque não chegava a exercitar as regras.
     *
     * O verificador consome na ordem em que as regras exigem; o que sobrar fica
     * sem uso. Fartura aqui é barata e garante que a partida ande até o fim,
     * que é onde o vencedor é decidido.
     */
    // Sempre a primeira opção. Ela existe em toda situação, e na quebra
    // irregular é "aceitar" — que segue a partida em vez de rearmar o rack e
    // consumir outra decisão.
    decisions: [0, 0, 0, 0, 0, 0],
    placements: Array.from({ length: 40 }, (_, k) => ({
      // Espalhadas pela mesa por sequência aritmética, longe das bordas para
      // não caírem fora dos limites depois de quantizadas.
      x: 0.2 + ((k * 37) % 100) / 100 * 1.55,
      y: 0.15 + ((k * 53) % 100) / 100 * 0.68,
    })),
    calls: Array.from({ length: 10 }, (_, k) => ({
      ball: 8,
      pocket: k % 6,
    })),
  }
}

/**
 * Assinatura do resultado de uma fixture.
 *
 * Inclui o VENCEDOR, que é o que a auditoria promete, e o hash da mesa final,
 * que pega uma divergência mesmo quando ela ainda não mudou quem ganhou —
 * detectar cedo é melhor que detectar quando já custou dinheiro.
 */
export function runReplayFixture(f: ReplayFixture): string {
  const r = verifyReplay(buildReplayFixture(f))
  return `${r.winner ?? '-'}:${r.shotsApplied}:${r.stateHash}`
}

export const runAllReplayFixtures = (): Record<string, string> =>
  Object.fromEntries(REPLAY_FIXTURES.map((f) => [f.name, runReplayFixture(f)]))
