/**
 * 업무프로세스 도식의 **불변식 검사** 🔑
 * (개발용 · `node tools/checkflow-check.js [DAG수] [시드] [--baseline]`).
 *
 * `checkflow.layoutDag` 는 순수 함수라 브라우저 없이 부를 수 있다. 랜덤 DAG 를 만들어
 * 좌표를 받아 놓고 「이건 절대 일어나면 안 된다」 를 세는 것이 전부다.
 * 손으로 만든 예시로는 층 수·갈래·긴 간선 조합이 몇 가지 안 나와, 실제로 카드 겹침과
 * 간선 관통·미부착을 놓친 적이 있다 (docs/checklist.md 의 V1~V7 · AGENT_LEARNING_LOG 참고).
 *
 * 테스트 러너를 들이지 않은 이유 🔑 - 이 프로젝트에 테스트 프레임워크가 없고, 검사 대상이
 * **순수 함수 두 개**(`flowNos`·`layoutDag`)라 의존성 없는 스크립트로 충분하다.
 *
 *   P1 카드 쌍 교차 0            P2 간선이 카드 내부를 지나지 않음   P3 간선 y 단조 비감소
 *   P4 같은 층 카드의 x 대역 서로소 + 층끼리 y 대역 서로소
 *   P5 x 는 `col * (lane + gapX)` + **반열 이동**(T자 · 층에 혼자인 카드만) 이산값
 *       (들여쓰기 항이 없다)
 *   P6 width/height·레인 폭이 실제 최대와 맞는다
 *   P7 노드 수 = 박스 수 · 간선 수 = `edges` 행 수 (그릴 수 있는 행)
 *   P8 부착 - 출발 = 카드 바닥 · 도착 = 카드 천장 · 꺾임은 층 사이 틈 안 · 경로는 `M·V·H` 만
 *   P9 화살촉이 도착점에 있고 모양·방향이 규격대로다
 *   P10 **어느 카드에서 어느 카드로** 이어지는지가 `edges` 와 맞는다
 *   P11 교차 수 - DAG 는 0 이 불가능하므로 **기준선 대비 악화**를 잡는다
 *       (중위·최대 + **합계** - 중위값이 0 이면 중간 구간의 악화가 드러나지 않는다)
 *   P12 **`flowNos` 의 층 내 순서 = `layoutDag` 의 열 순서** (번호와 열이 한 벌이다)
 *   P13 조건 라벨 칩끼리 **사각형 겹침 0** (겹치면 뒤의 칩을 눌러 팝오버를 열 수 없다)
 *
 * 🔑 **개수(P7)만 세면 연결 상대가 틀려도, 끝이 카드에서 떨어져도 0건이 나온다.**
 * 🔑 치수는 **5조합을 돌려가며** 넣는다 - 기본값으로만 돌리면 좁은 틈·간격 0 이 검사되지 않는다.
 * 🔑 **검사기를 믿기 전에 변이로 검사기를 검증한다** (더미 열 예약 제거 · 라벨 좌표 ·
 * 화살촉 규격 · 오배선 → 해당 항목만 올라오는지).
 * 🔑 **커버리지 카운터를 함께 찍는다** - 0건이 「없어서 0」인지 「만들어 봤는데 0」인지
 * 구분해야 한다 (긴 간선·3폭 이상 층·합류·갈래가 실제로 몇 건 나왔는지).
 * 🔑 **P11 기준선 키에는 생성기 설정 해시가 들어간다** - 생성기를 고치면 교차 수가 달라지므로
 * 옛 기준선과 비교하는 것은 뜻이 없다. `sum` 이 없는 낡은 기준선은 **실패**로 본다.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';
import { DAG_SIZE, dagCols, flowNos, laneWidth, layoutDag } from '../assets/js/checkflow.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const nums = args.filter((a) => !a.startsWith('--'));
const TOTAL = Number(nums[0] ?? 4000);
const SEED = Number(nums[1] ?? 20260918) >>> 0;
const BASE_FILE = path.join(path.dirname(url.fileURLToPath(import.meta.url)),
    'checkflow-baseline.json');

/** 시드 고정 난수 - 깨진 DAG 를 다시 만들어 볼 수 있어야 한다 (2번째 인자로 시드 교체) */
let seed = SEED;
function rnd() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
}
const pick = (n) => Math.floor(rnd() * n);

/** 치수 조합 - 기본값 + 극단값(좁은 틈 · 간격 0 · 넓은 간격) */
const OPTS = [
    {},
    { gapX: 40, gapY: 56 },
    { gapX: 16, gapY: 24 },
    { gapX: 120, gapY: 96 },
    { gapX: 0, gapY: 40 },
];

const fails = {
    P1: 0, P2: 0, P3: 0, P4: 0, P5: 0, P6: 0, P7: 0, P8: 0, P9: 0, P10: 0, P11: 0,
    P12: 0, P13: 0, EX: 0,
};
/** 커버리지 - 「검사할 거리가 실제로 나왔는지」 (0건이면 검사기를 못 믿는다) */
const cover = { span: 0, wide: 0, join: 0, fork: 0, label: 0 };
const first = {};
function note(k, msg) {
    fails[k] += 1;
    if (!first[k]) first[k] = msg;
}

/* ------------------------------ 랜덤 DAG 생성기 ------------------------------ */

const LABELS = ['국내', '해외', '조건A', '재작업', '반품', '수량 오류 시'];

/**
 * 생성기 설정 🔑 - **P11 기준선 키에 해시로 들어간다.**
 * 여기를 고치면 교차 수 분포가 달라져 옛 기준선과 비교할 수 없다.
 *   width 층 폭 최대 (4갈래 이상 층이 나와야 갈래 정렬을 검사한다)
 *   span  긴 간선의 최대 뛰어넘는 층 수 (더미 열 예약 검사)
 *   join  층마다 합류를 **의도적으로** 만들 확률
 */
const GEN = { v: 2, depth: 6, width: 5, span: 4, join: 0.45, label: 0.3 };

/** 설정 해시 (짧은 FNV-1a · 기준선 키에 붙는다) */
function hashOf(v) {
    const t = JSON.stringify(v);
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i += 1) {
        h = ((h ^ t.charCodeAt(i)) * 0x01000193) >>> 0;
    }
    return h.toString(36);
}
const GEN_KEY = hashOf(GEN);

/**
 * 랜덤 DAG 🔑 - **층을 먼저 배정하고 앞→뒤 간선만** 만든다 (순환을 만들 수 없다).
 * 층이 계산값(최장경로)과 같아지도록 층 L 의 노드마다 **L-1 층에서 오는 간선 하나**를 보장하고,
 * 그 위에 span 1~4 의 간선을 얹는다. 같은 from 의 `sort_order` 는 무작위 순열이다.
 */
function makeDag() {
    const depth = 2 + pick(GEN.depth);
    const at = [];
    const nodes = [];
    let id = 0;
    for (let L = 0; L < depth; L += 1) {
        at[L] = [];
        // 🔑 4갈래 이상 층도 나오게 한다 (3폭까지만 만들면 갈래 정렬이 거의 검사되지 않는다)
        const n = 1 + pick(GEN.width);
        for (let i = 0; i < n; i += 1) {
            id += 1;
            nodes.push({ id: `n${id}`, height: 24 + pick(9) * 22 });
            at[L].push(`n${id}`);
        }
    }
    const edges = [];
    const seen = new Set();
    const push = (from, to) => {
        const k = `${from}>${to}`;
        if (seen.has(k)) return;
        seen.add(k);
        edges.push({
            id: `e${edges.length}`,
            from,
            to,
            label: rnd() < GEN.label ? LABELS[pick(LABELS.length)] : '',
        });
    };
    at[0].forEach((to) => push(null, to));       // 시작 표시 (그리지 않는다)
    for (let L = 1; L < depth; L += 1) {
        at[L].forEach((to) => {
            push(at[L - 1][pick(at[L - 1].length)], to);
            for (let k = pick(3); k > 0; k -= 1) {
                // 🔑 뛰어넘을 층이 없으면 **버리지 않고** 가능한 범위에서 다시 고른다
                const back = 1 + pick(Math.min(GEN.span, L));
                const row = at[L - back];
                push(row[pick(row.length)], to);
            }
        });
        /* 합류를 의도적으로 만든다 - 앞 층의 노드 여럿을 이 층의 한 노드로 모은다
           (무작위로만 만들면 합류가 드물게 나와 합류 버스가 거의 검사되지 않는다) */
        if (rnd() < GEN.join && at[L - 1].length > 1) {
            const to = at[L][pick(at[L].length)];
            at[L - 1].forEach((from) => push(from, to));
        }
    }
    /* 같은 from 의 순서는 사용자가 정한 값이다 - 무작위 순열로 넣어 pin 이 지켜지는지 본다 */
    const byFrom = new Map();
    edges.forEach((e) => {
        if (!byFrom.has(e.from)) byFrom.set(e.from, []);
        byFrom.get(e.from).push(e);
    });
    byFrom.forEach((list) => {
        const order = list.map((_e, i) => i + 1);
        for (let i = order.length - 1; i > 0; i -= 1) {
            const j = pick(i + 1);
            [order[i], order[j]] = [order[j], order[i]];
        }
        list.forEach((e, i) => { e.sort_order = order[i]; });
    });
    for (let i = edges.length - 1; i > 0; i -= 1) {       // 입력 행 순서도 섞는다
        const j = pick(i + 1);
        [edges[i], edges[j]] = [edges[j], edges[i]];
    }
    return { nodes, edges, at };
}

/* ------------------------------ 기하 도구 ------------------------------ */

const key = (p) => `${p[0]},${p[1]}`;

/**
 * SVG 경로 → 꼭짓점. 🔑 **모르는 명령은 실패**다 (던진다).
 * 예전에는 `M`·`V` 외를 모두 `H` 로 읽어, 곡선(`C`·`A`)이나 상대좌표(`l`·`h`)를 쓰면
 * 엉뚱한 좌표로 조용히 통과했다.
 */
function points(d) {
    const out = [];
    let x = 0;
    let y = 0;
    String(d).trim().split(/(?=[A-Za-z])/).forEach((seg) => {
        const cmd = seg[0];
        const v = seg.slice(1).trim().split(/\s+/).filter(Boolean).map(Number);
        if (v.some((n) => !Number.isFinite(n))) throw new Error(`좌표 아님 «${d}»`);
        if (cmd === 'M' && v.length === 2) [x, y] = v;
        else if (cmd === 'V' && v.length === 1) [y] = v;
        else if (cmd === 'H' && v.length === 1) [x] = v;
        else throw new Error(`모르는 명령 ${cmd} «${d}»`);
        out.push([x, y]);
    });
    if (out.length < 2) throw new Error(`꼭짓점 부족 «${d}»`);
    return out;
}

/** 화살촉 경로 → 꼭짓점 좌표 (규격은 아래로 향하는 삼각형 하나뿐이다) */
function headTip(d) {
    const m = /^M(-?\d+) (-?\d+) l(-?\d+) (-?\d+) h(\d+) z$/.exec(String(d).trim());
    if (!m) return null;
    const [x, y, dx, dy, w] = m.slice(1).map(Number);
    if (dx !== -5 || dy !== -8 || w !== 10) return null;   // 위에서 아래로 꽂는 삼각형
    return [x, y];
}

const overlap = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1);

/**
 * 구간이 다른 구간 **안쪽**과 겹치는가.
 * 🔑 축에 나란한 선분은 한쪽 폭이 0 이라(`a1 === a2`) **점이 안쪽에 있는지**로 봐야 한다 -
 * 겹침 길이로만 보면 세로선이 카드를 관통해도 0 이 나와 못 잡는다.
 */
const cross = (a1, a2, b1, b2) => (a1 === a2 ? b1 < a1 && a1 < b2 : overlap(a1, a2, b1, b2) > 0);

/** 선분이 카드 **내부**를 지나는가 (출발·도착 카드의 경계 접점은 내부가 아니다) */
function hits(p, q, b) {
    return cross(Math.min(p[0], q[0]), Math.max(p[0], q[0]), b.x, b.x + b.w)
        && cross(Math.min(p[1], q[1]), Math.max(p[1], q[1]), b.y, b.y + b.h);
}

/** 점이 카드 바닥 / 천장 경계 위에 있는가 (P8·P10) */
const onBottom = (p, b) => p[1] === b.y + b.h && b.x <= p[0] && p[0] <= b.x + b.w;
const onTop = (p, b) => p[1] === b.y && b.x <= p[0] && p[0] <= b.x + b.w;

/**
 * 교차 수 (P11) - **서로 다른 간선**의 세로 구간과 가로 구간이 제 몸 안에서 만나는 횟수.
 * 같은 열을 함께 쓰는 세로선끼리, 같은 버스를 함께 쓰는 가로선끼리는 겹쳐 그려지는 것이라
 * 교차로 세지 않는다 (버스는 모여 보이는 것이 정상이다).
 */
function crossings(paths) {
    const segs = [];
    paths.forEach(({ ps }, i) => {
        for (let k = 1; k < ps.length; k += 1) {
            segs.push({ i, a: ps[k - 1], b: ps[k], vert: ps[k - 1][0] === ps[k][0] });
        }
    });
    let n = 0;
    for (let x = 0; x < segs.length; x += 1) {
        for (let y = x + 1; y < segs.length; y += 1) {
            const s = segs[x];
            const t = segs[y];
            if (s.i === t.i || s.vert === t.vert) continue;
            const v = s.vert ? s : t;
            const h = s.vert ? t : s;
            const hx = [Math.min(h.a[0], h.b[0]), Math.max(h.a[0], h.b[0])];
            const vy = [Math.min(v.a[1], v.b[1]), Math.max(v.a[1], v.b[1])];
            if (hx[0] < v.a[0] && v.a[0] < hx[1] && vy[0] < h.a[1] && h.a[1] < vy[1]) n += 1;
        }
    }
    return n;
}

/* ------------------------------ 한 판 검사 ------------------------------ */

/**
 * DAG 하나를 배치해 P1~P10 을 세고 교차 수를 돌려준다.
 * @returns {number} 교차 수 (P11 통계용)
 */
function checkOne(tag, nodes, edges, opts) {
    const lane = opts.lane;
    const gapX = opts.gapX ?? DAG_SIZE.gapX;
    const gapY = Math.max(opts.gapY ?? DAG_SIZE.gapY, 8);
    const res = layoutDag(nodes, edges, { lane, gapX, gapY });
    const { boxes, layers, cols, width, height } = res;
    const list = Object.entries(boxes).map(([id, b]) => ({ id, ...b }));
    const pitch = lane + gapX;

    /* P1 카드 겹침 */
    list.forEach((a, i) => list.slice(i + 1).forEach((b) => {
        if (overlap(a.x, a.x + a.w, b.x, b.x + b.w) > 0
            && overlap(a.y, a.y + a.h, b.y, b.y + b.h) > 0) {
            note('P1', `${tag} ${a.id}(x${a.x} y${a.y}) x ${b.id}(x${b.x} y${b.y})`);
        }
    }));

    /* 층 띠 - 카드 y 는 층마다 하나뿐이고 띠 바닥은 층 내 최대 높이다 */
    const band = layers.map((row) => {
        const bs = row.map((id) => boxes[id]);
        return [Math.min(...bs.map((b) => b.y)), Math.max(...bs.map((b) => b.y + b.h))];
    });

    /* P4 같은 층 x 대역 서로소 · 층끼리 y 대역 서로소 */
    layers.forEach((row, L) => {
        const bs = row.map((id) => boxes[id]);
        bs.forEach((a, i) => bs.slice(i + 1).forEach((b) => {
            if (overlap(a.x, a.x + a.w, b.x, b.x + b.w) > 0) {
                note('P4', `${tag} 층${L + 1} x 대역 겹침 ${a.x} x ${b.x}`);
            }
        }));
    });
    band.forEach((a, i) => band.slice(i + 1).forEach((b) => {
        if (overlap(a[0], a[1], b[0], b[1]) > 0) note('P4', `${tag} 층 y 대역 겹침 ${a} x ${b}`);
    }));

    /* P5 x 이산값 - 열 좌표 + **반열 이동(T자)** 뿐이다 (들여쓰기 항이 없다)
       🔑 반열까지 넓힌 이유: 갈래 부모를 자식 열 범위의 **가운데 위**에 놓는 T자 배치가
       `col * pitch + k * (pitch / 2)` 를 만든다 (checkflow.layoutDag). 그래도 카드 폭·층 천장은
       그대로여야 하고, 이동은 ① 반열의 정수배 ② 오른쪽으로만 ③ **그 층에 카드가 하나뿐일 때만**
       허용한다 - 옆에 카드가 있는 층에서 옮기면 x 대역이 겹치거나(P4) 지나가는 선을 삼킨다(P2).
       세 조건으로 조여 두어 「임의의 들여쓰기」는 여전히 실패로 잡힌다 */
    const half = Math.max(1, Math.round(pitch / 2));
    layers.forEach((row, L) => row.forEach((id) => {
        const b = boxes[id];
        const moved = b.x - cols[id] * pitch;
        if (moved < 0 || moved % half !== 0 || b.w !== lane) {
            note('P5', `${tag} ${id} x${b.x} col${cols[id]} pitch${pitch} 이동${moved}`);
        }
        if (moved && row.length > 1) {
            note('P5', `${tag} ${id} 층${L + 1} 에 카드가 ${row.length}개인데 이동${moved}`);
        }
        if (b.y !== band[L][0]) note('P5', `${tag} ${id} y${b.y} != 층 천장 ${band[L][0]}`);
    }));

    /* 경로 파싱 (P8 문법) */
    const paths = [];
    res.edges.forEach((e) => {
        try {
            paths.push({ e, ps: points(e.path) });
        } catch (err) {
            note('P8', `${tag} ${err.message}`);
        }
    });

    /* P2 관통 · P3 단조 */
    paths.forEach(({ e, ps }) => {
        for (let i = 1; i < ps.length; i += 1) {
            if (ps[i][1] < ps[i - 1][1]) note('P3', `${tag} ${e.path}`);
            list.forEach((b) => {
                if (hits(ps[i - 1], ps[i], b)) {
                    note('P2', `${tag} 선 ${e.path} · 카드 ${b.id} `
                        + `x${b.x}~${b.x + b.w} y${b.y}~${b.y + b.h}`);
                }
            });
        }
    });

    /* P8 부착 - 출발은 카드 바닥, 도착은 카드 천장, 가로 꺾임은 층 사이 틈 안, 라벨은 첫 세로 위 */
    const inGap = (y) => band.some((b, i) => i + 1 < band.length && b[1] < y && y < band[i + 1][0]);
    paths.forEach(({ e, ps }) => {
        const a = boxes[e.from];
        const b = boxes[e.to];
        if (!a || !b) {
            note('P8', `${tag} 모르는 카드 ${e.from}→${e.to}`);
            return;
        }
        if (!onBottom(ps[0], a)) note('P8', `${tag} 출발점 (${ps[0]}) 이 ${e.from} 바닥이 아니다`);
        const end = ps[ps.length - 1];
        if (!onTop(end, b)) note('P8', `${tag} 도착점 (${end}) 이 ${e.to} 천장이 아니다`);
        for (let i = 1; i < ps.length; i += 1) {
            if (ps[i][1] === ps[i - 1][1] && !inGap(ps[i][1])) {
                note('P8', `${tag} 가로 꺾임 y${ps[i][1]} 이 층 사이 틈 밖이다 · 선 ${e.path}`);
            }
        }
        if (!e.label) return;
        /* 🔑 라벨은 **출발 카드가 있는 층 아래 틈** 안에 있어야 한다 (사각형이라 중심으로 본다).
           예전에는 「첫 세로 구간 위」였는데, 그러면 같은 from 의 갈래 라벨이 한 점에 겹쳤다 */
        const lc = [e.label.x + e.label.w / 2, e.label.y + e.label.h / 2];
        if (!(e.label.w > 0 && e.label.h > 0)) {
            note('P8', `${tag} 라벨 크기 ${e.label.w}x${e.label.h}`);
        }
        const li = layers.findIndex((row) => row.includes(e.from));
        const gap = li >= 0 && li + 1 < band.length
            ? [band[li][1], band[li + 1][0]]
            : null;
        if (!gap || !(gap[0] < lc[1] && lc[1] < gap[1])) {
            note('P8', `${tag} 라벨 y${lc[1]} 이 층${li + 1} 아래 틈 `
                + `${gap ? `${gap[0]}~${gap[1]}` : '없음'} 밖이다`);
        }
        if (list.some((c) => c.x < lc[0] && lc[0] < c.x + c.w
            && c.y < lc[1] && lc[1] < c.y + c.h)) {
            note('P8', `${tag} 라벨 (${lc}) 이 카드 안이다`);
        }
    });

    /* P13 라벨 칩끼리 겹침 - 겹치면 뒤의 칩을 눌러 팝오버를 열 수 없다 */
    const chips = res.edges.filter((e) => e.label).map((e) => ({ id: e.id, ...e.label }));
    cover.label += chips.length;
    chips.forEach((a, i) => chips.slice(i + 1).forEach((b) => {
        if (overlap(a.x, a.x + a.w, b.x, b.x + b.w) > 0
            && overlap(a.y, a.y + a.h, b.y, b.y + b.h) > 0) {
            note('P13', `${tag} 라벨 ${a.id}(x${a.x} y${a.y} w${a.w}) `
                + `x ${b.id}(x${b.x} y${b.y} w${b.w})`);
        }
    }));

    /* P12 번호(flowNos)와 열(layoutDag)이 한 벌인가 🔑 - 층 내 순서의 출처가 하나여야 한다 */
    const nos = flowNos(nodes, edges);
    if (nos.layers.length !== layers.length) {
        note('P12', `${tag} 층 수 ${nos.layers.length} != ${layers.length}`);
    } else {
        nos.layers.forEach((row, L) => {
            if (row.join('>') !== layers[L].join('>')) {
                note('P12', `${tag} 층${L + 1} 순서 ${row} != 열 순서 ${layers[L]}`);
                return;
            }
            row.forEach((id, k) => {
                if (k && cols[row[k - 1]] >= cols[id]) {
                    note('P12', `${tag} 층${L + 1} 열이 왼→오 가 아니다 `
                        + `${row[k - 1]}(${cols[row[k - 1]]}) ${id}(${cols[id]})`);
                }
                const want = row.length > 1 ? `${L + 1}.${k + 1}` : `${L + 1}`;
                if (nos.no[id] !== want) {
                    note('P12', `${tag} 번호 ${id} = ${nos.no[id]} (기대 ${want})`);
                }
                if (nos.layer[id] !== L + 1) {
                    note('P12', `${tag} 층 ${id} = ${nos.layer[id]} (기대 ${L + 1})`);
                }
            });
        });
    }

    /* P9 화살촉 - 카드 천장에 꽂히고 꼭짓점이 도착점과 같다 */
    paths.forEach(({ e, ps }) => {
        const end = ps[ps.length - 1];
        const tip = headTip(e.head);
        if (!tip) {
            note('P9', `${tag} 화살촉 규격 아님 «${e.head}»`);
            return;
        }
        if (key(tip) !== key(end)) note('P9', `${tag} 화살촉 (${tip}) != 도착점 (${end})`);
        if (!boxes[e.to] || !onTop(tip, boxes[e.to])) {
            note('P9', `${tag} 화살촉 (${tip}) 이 ${e.to} 천장에 없다`);
        }
    });

    /* P7 개수 - 그릴 수 있는 행(from 이 있고 양 끝을 아는 행)만큼 나와야 한다 */
    const ids = new Set(nodes.map((n) => n.id));
    const want = edges.filter((e) => e.from != null && ids.has(e.from) && ids.has(e.to)
        && e.from !== e.to);
    if (list.length !== nodes.length) {
        note('P7', `${tag} 노드 ${nodes.length} != 박스 ${list.length}`);
    }
    if (res.edges.length !== want.length) {
        note('P7', `${tag} 간선 ${res.edges.length} != 예상 ${want.length}`);
    }

    /* P10 연결 상대 - `edges` 행을 기대값으로 직접 비교한다 (id·출발·도착·실제 부착 카드) */
    const got = new Map(res.edges.map((e) => [e.id, e]));
    want.forEach((e) => {
        const out = got.get(e.id);
        if (!out) {
            note('P10', `${tag} 간선 ${e.id} (${e.from}→${e.to}) 이 없다`);
            return;
        }
        if (out.from !== e.from || out.to !== e.to) {
            note('P10', `${tag} ${e.id} ${out.from}→${out.to} != ${e.from}→${e.to}`);
            return;
        }
        let ps;
        try {
            ps = points(out.path);
        } catch {
            return;                                    // P8 이 이미 세었다
        }
        const a = list.find((b) => onBottom(ps[0], b));
        const z = list.find((b) => onTop(ps[ps.length - 1], b));
        if (a?.id !== e.from || z?.id !== e.to) {
            note('P10', `${tag} ${e.id} 선이 ${a?.id}→${z?.id} 에 붙었다 `
                + `(기대 ${e.from}→${e.to})`);
        }
    });

    /* P6 치수 - width 는 카드와 더미 열(선이 지나는 열 오른쪽 끝)까지 덮어야 한다 */
    const lineX = paths.reduce((m, { ps }) => ps.reduce((n, p) => Math.max(n, p[0]), m), 0);
    const right = list.reduce((m, b) => Math.max(m, b.x + b.w), 0);
    const chipX = chips.reduce((m, c) => Math.max(m, c.x + c.w), 0);
    const w = Math.round(Math.max(right, chipX, paths.length ? lineX + lane / 2 : 0))
        + DAG_SIZE.pad;
    const h = list.reduce((m, b) => Math.max(m, b.y + b.h), 0) + DAG_SIZE.pad;
    if (w !== width || h !== height) note('P6', `${tag} ${width}/${height} != ${w}/${h}`);

    /* 레인 폭도 같은 간격·열 수로 계산해야 한다 (폭과 좌표가 어긋나면 선이 카드에서 떨어진다) */
    const count = dagCols(nodes, edges);
    if (count < Math.max(1, ...layers.map((row) => row.length))) {
        note('P6', `${tag} dagCols ${count} < 실제 층 폭`);
    }
    const avail = 600 + pick(10) * 120;
    const lw = laneWidth(avail, count, { gapX });
    if (lw > DAG_SIZE.laneMin && lw * count + gapX * (count - 1) > avail) {
        note('P6', `${tag} 레인 ${lw} x ${count} 열 = `
            + `${lw * count + gapX * (count - 1)} > 가용 ${avail}`);
    }

    /* 커버리지 - 검사할 거리가 실제로 나왔는지 (P12·P13 은 갈래·합류가 없으면 늘 0건이다) */
    const inDeg = new Map();
    const outDeg = new Map();
    edges.filter((e) => e.from != null).forEach((e) => {
        inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
        outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
        if (Math.abs((nos.layer[e.to] ?? 0) - (nos.layer[e.from] ?? 0)) > 1) cover.span += 1;
    });
    cover.join += [...inDeg.values()].filter((n) => n > 1).length;
    cover.fork += [...outDeg.values()].filter((n) => n > 1).length;
    cover.wide += layers.filter((row) => row.length >= 3).length;

    return crossings(paths);
}

/* ------------------------------ 고정 예시 ------------------------------ */

/** 문서의 예시(국내·해외 갈래 · p7→p8 span 3)를 번호·열·더미 수까지 단언한다 */
function checkExample() {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'];
    const nodes = ids.map((id) => ({ id, height: 40 }));
    const raw = [
        [null, 'p1', 1, ''], ['p1', 'p2', 1, ''], ['p2', 'p3', 1, ''],
        ['p3', 'p4', 1, '국내'], ['p3', 'p7', 2, '해외'],
        ['p4', 'p5', 1, ''], ['p5', 'p6', 1, ''], ['p6', 'p8', 1, ''], ['p7', 'p8', 1, ''],
        ['p8', 'p9', 1, ''],
    ];
    const edges = raw.map(([from, to, so, label], i) => ({
        id: `x${i}`, from, to, sort_order: so, label,
    }));
    const want = {
        p1: '1', p2: '2', p3: '3', p4: '4.1', p7: '4.2', p5: '5', p6: '6', p8: '7', p9: '8',
    };
    const { no, layer, layers } = flowNos(nodes, edges);
    ids.forEach((id) => {
        if (no[id] !== want[id]) note('EX', `번호 ${id} = ${no[id]} (기대 ${want[id]})`);
    });
    if (layer.p8 !== 7) note('EX', `p8 층 ${layer.p8} (기대 7)`);
    if (layers.length !== 8) note('EX', `층 수 ${layers.length} (기대 8)`);

    const dag = layoutDag(nodes, edges, { lane: 240, gapX: 40, gapY: 56 });
    const wantCol = { p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0, p7: 1, p8: 0, p9: 0 };
    ids.forEach((id) => {
        if (dag.cols[id] !== wantCol[id]) {
            note('EX', `열 ${id} = ${dag.cols[id]} (기대 ${wantCol[id]})`);
        }
    });
    if (dag.dummies !== 2) note('EX', `더미 ${dag.dummies} (기대 2 - p7→p8 이 5·6층을 예약)`);
    /* 🔑 T자 - 갈래 부모 ③(p3) 은 자식 자리(4.1 열 0 · 4.2 가 내려오는 더미 열 1) 가운데인
       **반열**로 가고, 그 위 순차 줄기(①②)도 따라 올라온다. 층에 둘인 4.1 은 제자리다 */
    const halfX = (240 + 40) / 2;
    ['p1', 'p2', 'p3'].forEach((id) => {
        if (dag.boxes[id].x !== halfX) {
            note('EX', `T자 ${id} x${dag.boxes[id].x} (기대 ${halfX} · 자식 열 범위 가운데)`);
        }
    });
    if (dag.boxes.p4.x !== 0) {
        note('EX', `T자 p4 x${dag.boxes.p4.x} (기대 0 · 층에 둘이라 옮기지 않는다)`);
    }
    if (dag.width !== 240 * 2 + 40 + DAG_SIZE.pad) note('EX', `폭 ${dag.width} (기대 2열)`);
    const long = dag.edges.find((e) => e.from === 'p7' && e.to === 'p8');
    const px = points(long.path).map((p) => p[0]);
    if (!px.includes(1 * (240 + 40) + 120)) note('EX', 'p7→p8 이 더미 열(1)로 내려오지 않는다');
    const cross = checkOne('EX', nodes, edges, { lane: 240, gapX: 40, gapY: 56 });
    const labels = dag.edges.filter((e) => e.label).length;
    /* 🔑 찍어만 보지 않고 단언한다 - 교차 0 · 라벨 2개(국내·해외)가 이 예시의 정답이다 */
    if (cross !== 0) note('EX', `교차 ${cross} (기대 0)`);
    if (labels !== 2) note('EX', `라벨 ${labels}개 (기대 2 - 국내·해외)`);
    const chips = dag.edges.filter((e) => e.label).map((e) => e.label);
    if (chips.length === 2 && overlap(chips[0].x, chips[0].x + chips[0].w,
        chips[1].x, chips[1].x + chips[1].w) > 0) {
        note('EX', '국내·해외 라벨이 x 대역에서 겹친다');
    }
    return { cross, labels };
}

/* ------------------------------ 실행 ------------------------------ */

const ex = checkExample();
const crossList = [];
for (let t = 0; t < TOTAL; t += 1) {
    const { nodes, edges } = makeDag();
    const o = { ...OPTS[t % OPTS.length], lane: 200 + pick(4) * 20 };
    crossList.push(checkOne(`t${t}`, nodes, edges, o));
}

const sorted = [...crossList].sort((a, b) => a - b);
const mid = sorted.length
    ? (sorted.length % 2
        ? sorted[sorted.length >> 1]
        : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2)
    : 0;
const max = sorted.length ? sorted[sorted.length - 1] : 0;
/* 🔑 합계도 기준선에 넣는다 - 중위값이 0 이면(절반 넘게 교차 0) 중간 구간의 악화를 못 잡는다 */
const sum = crossList.reduce((m, v) => m + v, 0);
/* 🔑 기준선 키에 **생성기 설정 해시**를 넣는다 - 생성기를 고치면 옛 교차 수와 비교할 수 없다 */
const runKey = `${TOTAL}:${SEED}:g${GEN_KEY}`;
const reason = args.find((a) => a.startsWith('--reason='))?.slice(9) ?? '';
const base = fs.existsSync(BASE_FILE)
    ? JSON.parse(fs.readFileSync(BASE_FILE, 'utf8'))
    : { note: '랜덤 DAG 교차 수 기준선 - `npm run check:flow -- --baseline` 으로 다시 쓴다', runs: {} };
let p11 = '';
if (flags.has('--baseline')) {
    base.runs[runKey] = {
        median: mid, max, sum, gen: GEN, reason, at: new Date().toISOString().slice(0, 10),
    };
    fs.writeFileSync(BASE_FILE, `${JSON.stringify(base, null, 4)}\n`);
    p11 = `기준선 기록 ${runKey} → 중위 ${mid} · 최대 ${max} · 합계 ${sum}`
        + `${reason ? ` (사유: ${reason})` : ' ⚠️ --reason= 로 사유를 남긴다'}`;
} else {
    const b = base.runs[runKey];
    if (!b) {
        note('P11', `기준선 없음 (${runKey}) - `
            + 'npm run check:flow -- --baseline --reason=사유 로 기록한다');
        p11 = `기준선 없음 · 이번 중위 ${mid} · 최대 ${max} · 합계 ${sum}`;
    } else if (b.sum == null) {
        // 🔑 합계 없는 낡은 기준선은 통과로 쳐 주지 않는다 (중간 구간의 악화를 못 잡는다)
        note('P11', `기준선에 합계가 없다 (${runKey}) - --baseline 으로 다시 기록한다`);
        p11 = `낡은 기준선 (합계 없음) · 이번 합계 ${sum}`;
    } else if (mid > b.median || max > b.max || sum > b.sum) {
        note('P11', `교차 악화 중위 ${mid}/${b.median} · 최대 ${max}/${b.max} `
            + `· 합계 ${sum}/${b.sum}`);
        p11 = `기준선 중위 ${b.median} · 최대 ${b.max} · 합계 ${b.sum}`;
    } else {
        p11 = `기준선 중위 ${b.median} · 최대 ${b.max} · 합계 ${b.sum} `
            + `→ 이번 중위 ${mid} · 최대 ${max} · 합계 ${sum}`;
    }
}

const bad = Object.values(fails).some(Boolean);
const lines = Object.entries(fails)
    .map(([k, v]) => `  ${k}: ${v}건${v ? `   예: ${first[k]}` : ''}`);
process.stdout.write(`랜덤 DAG ${TOTAL}개 불변식 검사 (시드 ${SEED})\n`);
process.stdout.write(`${lines.join('\n')}\n`);
process.stdout.write(`  P11 ${p11}\n`);
process.stdout.write(`  고정 예시 교차 ${ex.cross} · 라벨 ${ex.labels}개\n`);
process.stdout.write(`  커버리지 - 긴 간선 ${cover.span} · 3폭 이상 층 ${cover.wide} `
    + `· 합류 ${cover.join} · 갈래 ${cover.fork} · 라벨 ${cover.label} `
    + `(생성기 g${GEN_KEY})\n`);
process.stdout.write(`${bad ? 'FAIL' : 'PASS'}\n`);
process.exitCode = bad ? 1 : 0;
