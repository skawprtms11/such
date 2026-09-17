/**
 * 업무프로세스 도식의 **불변식 검사** 🔑 (개발용 · `node tools/checkflow-check.js [트리수] [시드]`).
 *
 * `checkflow.layoutFlow` 는 순수 함수라 브라우저 없이 부를 수 있다. 랜덤 트리를 만들어
 * 좌표를 받아 놓고 「이건 절대 일어나면 안 된다」 를 세는 것이 전부다.
 * 손으로 만든 예시로는 높이·깊이·갈래 조합이 몇 가지 안 나와, 실제로 카드 겹침과
 * 간선 관통을 놓친 적이 있다 (docs/checklist.md 의 V1~V6 참고).
 *
 * 테스트 러너를 들이지 않은 이유 🔑 - 이 프로젝트에 테스트 프레임워크가 없고, 검사 대상이
 * **순수 함수 한 개**라 의존성 없는 스크립트로 충분하다. 도식 배치를 건드리면 돌린다.
 *
 *   P1 카드 쌍 교차 0          P2 간선이 카드 내부를 지나지 않음   P3 간선 y 단조 비감소
 *   P4 갈래 서브트리 x 대역 서로소   P5 x 는 `colX(정수) + 들여쓰기`   P6 width/height 가 실제 최대
 *   P7 노드 수 = 박스 수 · 간선 수 = 예상 수
 *   P8 간선 끝점이 **카드 경계나 버스에 붙는다** · 경로는 `M·V·H` 만 쓴다
 *   P9 화살촉이 도착점에 있고 모양·방향이 규칙대로다
 *   P10 **어느 카드에서 어느 카드로** 이어지는지가 트리 구조와 맞는다
 *
 * 🔑 **P8·P9·P10 이 없던 동안 「선이 허공에서 시작하는」 결함이 통과했다.**
 * 개수(P7)만 세면 연결 상대가 틀려도, 끝이 카드에서 떨어져도 0건이 나온다.
 * 🔑 치수는 **5조합을 돌려가며** 넣는다 - `gapX`·`gapY`·들여쓰기를 기본값으로만 돌리면
 * `colGap()` 파생(들여쓰기가 `gapX` 보다 큰 경우)이 검사되지 않는다.
 */
import process from 'node:process';
import { FLOW_SIZE, colGap, laneWidth, layoutFlow, tails } from '../assets/js/checkflow.js';

/** 시드 고정 난수 - 깨진 트리를 다시 만들어 볼 수 있어야 한다 (2번째 인자로 시드 교체) */
let seed = Number(process.argv[3] ?? 20260917) >>> 0;
function rnd() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
}
const pick = (n) => Math.floor(rnd() * n);

/** 치수 조합 - 기본값 + 극단값. `colGap()` 이 들여쓰기 상한을 지켜 주는지 함께 본다 */
const OPTS = [
    {},
    { gapX: 40, gapY: 40, indent: 24 },   // gapX < 들여쓰기 상한 48 → colGap 이 올려야 한다
    { gapX: 120, gapY: 24, indent: 8 },
    { gapX: 24, gapY: 96, indent: 40 },   // 들여쓰기가 gapX 보다 크다
    { gapX: 56, gapY: 56, indent: 0 },    // 들여쓰기 없음
];

let uid = 0;

/** 랜덤 트리 한 그루 (높이·갈래·합류를 섞는다) */
function makeTree(depth, maxKids) {
    uid += 1;
    const node = {
        id: `n${uid}`, height: 24 + pick(9) * 22, fork: false, join: false, children: [],
    };
    if (depth <= 0) return node;
    const kids = pick(maxKids + 1);
    for (let i = 0; i < kids; i += 1) node.children.push(makeTree(depth - 1, maxKids));
    if (kids) {
        node.fork = rnd() < 0.45;
        if (node.fork) node.join = rnd() < 0.5;
    }
    return node;
}

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
    d.trim().split(/(?=[A-Za-z])/).forEach((seg) => {
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
    const m = /^M(-?\d+) (-?\d+) l(-?\d+) (-?\d+) h(\d+) z$/.exec(d.trim());
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
    const xs = Math.min(p[0], q[0]);
    const xe = Math.max(p[0], q[0]);
    const ys = Math.min(p[1], q[1]);
    const ye = Math.max(p[1], q[1]);
    return cross(xs, xe, b.x, b.x + b.w) && cross(ys, ye, b.y, b.y + b.h);
}

/** 점이 카드 바닥 / 천장 경계 위에 있는가 (P8·P10) */
const onBottom = (p, b) => p[1] === b.y + b.h && b.x <= p[0] && p[0] <= b.x + b.w;
const onTop = (p, b) => p[1] === b.y && b.x <= p[0] && p[0] <= b.x + b.w;

/** 서브트리의 노드 전부 */
function flat(node, out = []) {
    out.push(node);
    (node.children ?? []).forEach((k) => flat(k, out));
    return out;
}

const fails = {
    P1: 0, P2: 0, P3: 0, P4: 0, P5: 0, P6: 0, P7: 0, P8: 0, P9: 0, P10: 0,
};
const first = {};
function note(key_, msg) {
    fails[key_] += 1;
    if (!first[key_]) first[key_] = msg;
}

/** 서브트리가 차지하는 x 대역 */
const bandOf = (node, at) => {
    const bs = flat(node).map((n) => at.get(n.id));
    return [Math.min(...bs.map((b) => b.x)), Math.max(...bs.map((b) => b.x + b.w))];
};

/** 갈래 형제들의 x 대역이 서로소인가 (P4) */
function checkBands(list, at, tag) {
    const bands = list.map((k) => bandOf(k, at));
    bands.forEach((a, i) => bands.slice(i + 1).forEach((b) => {
        if (overlap(a[0], a[1], b[0], b[1]) > 0) note('P4', `${tag} ${a} x ${b}`);
    }));
}

const kidsOf = (n) => n.children ?? [];
const joinsKids = (n) => !!n.join && !!kidsOf(n).length;

/** 간선 수 예상값 - 합류 형제 뒤는 말단 수 + 버스 1 (P7) */
function chainCount(list) {
    return list.slice(1).reduce((m, _node, i) => {
        const prev = list[i];
        return m + (joinsKids(prev) ? tails(prev).length + 1 : 1);
    }, 0);
}

/**
 * 「어느 카드에서 어느 카드로」 기대값 (P10).
 * 화살촉이 꽂히는 카드마다 **들어오는 간선 수**와 **허용되는 출발 카드**를 적는다.
 *   exact - 출발 카드 집합이 정확히 이것이어야 한다 (합류: 갈래 말단 전부)
 *   allow - 출발 카드가 이 안에 있어야 한다 (비합류 갈래 블록: 앞 서브트리 어딘가)
 */
function wiringSpec(roots, rootFork) {
    const want = new Map();
    const rows = [];
    const collect = (list, parent) => {
        rows.push({ list, parent });
        list.forEach((n) => { if (kidsOf(n).length) collect(kidsOf(n), n); });
    };
    collect(roots, null);
    flat({ children: roots }).forEach((n) => { if (n.id) want.set(n.id, { n: 0 }); });

    rows.forEach(({ list, parent }) => {
        if (parent) {
            const ids = new Set([parent.id]);
            const fork = parent.fork || parent.join;
            (fork ? list : list.slice(0, 1)).forEach((k) => {
                want.set(k.id, { n: 1, exact: ids });
            });
            if (fork) return;
        } else if (rootFork) {
            return;
        }
        list.slice(1).forEach((node, i) => {
            const prev = list[i];
            want.set(node.id, joinsKids(prev)
                ? { n: 1, exact: new Set(tails(prev).map((x) => x.id)) }
                : { n: 1, allow: new Set(flat(prev).map((x) => x.id)) });
        });
    });
    return want;
}

function checkOne(t) {
    uid = 0;
    const rootFork = rnd() < 0.3;
    const roots = [];
    const count = 1 + pick(4);
    for (let i = 0; i < count; i += 1) roots.push(makeTree(1 + pick(4), 3));
    const lane = 200 + pick(4) * 20;
    const o = OPTS[t % OPTS.length];
    const { boxes, edges, width, height } = layoutFlow(roots, { rootFork, lane, ...o });
    const at = new Map(boxes.map((b) => [b.id, b]));
    const step = o.indent ?? FLOW_SIZE.indent;
    const pitch = lane + colGap(o.gapX ?? FLOW_SIZE.gapX, step);

    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => {
        if (overlap(a.x, a.x + a.w, b.x, b.x + b.w) > 0
            && overlap(a.y, a.y + a.h, b.y, b.y + b.h) > 0) {
            note('P1', `t${t} ${a.id}(x${a.x} y${a.y}) x ${b.id}(x${b.x} y${b.y})`);
        }
    }));

    /* 경로 파싱 (P8 문법) */
    const paths = [];
    edges.forEach((e) => {
        try {
            paths.push({ e, ps: points(e.d) });
        } catch (err) {
            note('P8', `t${t} ${err.message}`);
        }
    });

    paths.forEach(({ e, ps }) => {
        for (let i = 1; i < ps.length; i += 1) {
            if (ps[i][1] < ps[i - 1][1]) note('P3', `t${t} ${e.d}`);
            boxes.forEach((b) => {
                if (hits(ps[i - 1], ps[i], b)) {
                    note('P2', `t${t} 선 ${e.d} · 카드 ${b.id} `
                        + `x${b.x}~${b.x + b.w} y${b.y}~${b.y + b.h}`);
                }
            });
        }
    });

    /* P8 부착 - 출발은 카드 바닥이거나 **앞 간선이 끝난 버스**, 도착은 카드 천장이거나
       **뒤 간선이 시작하는 버스**. 어느 쪽도 아니면 선이 허공에 떠 있다 */
    const startAt = new Set(paths.map(({ ps }) => key(ps[0])));
    const endAt = new Set(paths.map(({ ps }) => key(ps[ps.length - 1])));
    const fromCard = (p) => boxes.find((b) => onBottom(p, b));
    const toCard = (p) => boxes.find((b) => onTop(p, b));
    paths.forEach(({ e, ps }) => {
        const head = ps[0];
        const tail = ps[ps.length - 1];
        if (!fromCard(head) && !endAt.has(key(head))) {
            note('P8', `t${t} 출발점 (${head}) 이 카드·버스 어디에도 없다 · 선 ${e.d}`);
        }
        if (!toCard(tail) && !startAt.has(key(tail))) {
            note('P8', `t${t} 도착점 (${tail}) 이 카드·버스 어디에도 없다 · 선 ${e.d}`);
        }
    });

    /* P9 화살촉 - 카드에 꽂히는 간선만 갖고, 꼭짓점이 도착점과 같아야 한다 */
    paths.forEach(({ e, ps }) => {
        const tail = ps[ps.length - 1];
        const lands = !!toCard(tail);
        if (!e.head) {
            if (lands) note('P9', `t${t} 카드에 닿는데 화살촉이 없다 · 선 ${e.d}`);
            return;
        }
        const tip = headTip(e.head);
        if (!tip) {
            note('P9', `t${t} 화살촉 규격 아님 «${e.head}»`);
            return;
        }
        if (!lands) note('P9', `t${t} 카드에 닿지 않는데 화살촉이 있다 · 선 ${e.d}`);
        if (key(tip) !== key(tail)) {
            note('P9', `t${t} 화살촉 (${tip}) != 도착점 (${tail}) · 선 ${e.d}`);
        }
    });

    /* P10 연결 상대 - 화살촉이 꽂힌 카드마다 출발 카드를 되짚어 트리 구조와 맞춘다 */
    const departures = (ps, depth = 0) => {
        const b = fromCard(ps[0]);
        if (b) return [b.id];
        if (depth > 4) return [];
        const k = key(ps[0]);
        return paths
            .filter((p) => key(p.ps[p.ps.length - 1]) === k)
            .flatMap((p) => departures(p.ps, depth + 1));
    };
    const incoming = new Map();
    paths.forEach(({ e, ps }) => {
        if (!e.head) return;
        const b = toCard(ps[ps.length - 1]);
        if (!b) return;                                  // P9 가 이미 세었다
        if (!incoming.has(b.id)) incoming.set(b.id, []);
        incoming.get(b.id).push(new Set(departures(ps)));
    });
    const want = wiringSpec(roots, rootFork);
    want.forEach((spec, id) => {
        const got = incoming.get(id) ?? [];
        if (got.length !== spec.n) {
            note('P10', `t${t} ${id} 들어오는 간선 ${got.length} != ${spec.n}`);
            return;
        }
        got.forEach((from) => {
            const list = [...from];
            const ok = spec.exact
                ? list.length === spec.exact.size && list.every((x) => spec.exact.has(x))
                : list.length > 0 && list.every((x) => spec.allow.has(x));
            if (!ok) {
                note('P10', `t${t} ${id} ← [${list}] `
                    + `(기대 ${spec.exact ? `정확히 [${[...spec.exact]}]` : '앞 서브트리 안'})`);
            }
        });
    });

    const all = roots.flatMap((n) => flat(n));
    all.forEach((n) => {
        const kids = kidsOf(n);
        if (kids.length && (n.fork || n.join)) checkBands(kids, at, `t${t} ${n.id}`);
    });
    if (rootFork) checkBands(roots, at, `t${t} root`);

    boxes.forEach((b) => {
        if (![0, step, step * 2].includes(b.indent) || (b.x - b.indent) % pitch !== 0) {
            note('P5', `t${t} ${b.id} x${b.x} indent${b.indent}`);
        }
    });

    const w = boxes.reduce((m, b) => Math.max(m, b.x + b.w), 0) + FLOW_SIZE.pad;
    const h = boxes.reduce((m, b) => Math.max(m, b.y + b.h), 0) + FLOW_SIZE.pad;
    if (w !== width || h !== height) note('P6', `t${t} ${width}/${height} != ${w}/${h}`);

    /* 레인 폭도 같은 간격으로 계산해야 한다 (폭 계산과 좌표 계산이 어긋나면 선이 떨어진다) */
    const cols = 1 + pick(5);
    const avail = 600 + pick(10) * 120;
    const lw = laneWidth(avail, cols, o);
    const total = lw * cols + colGap(o.gapX ?? FLOW_SIZE.gapX, step) * (cols - 1);
    if (lw > FLOW_SIZE.laneMin && total > avail) {
        note('P6', `t${t} 레인 ${lw} x ${cols} 열 = ${total} > 가용 ${avail}`);
    }

    if (all.length !== boxes.length) note('P7', `t${t} 노드 ${all.length} != 박스 ${boxes.length}`);
    let wantN = rootFork ? 0 : chainCount(roots);
    all.forEach((n) => {
        const kids = kidsOf(n);
        if (!kids.length) return;
        wantN += (n.fork || n.join) ? 1 + kids.length : 1 + chainCount(kids);
    });
    if (wantN !== edges.length) note('P7', `t${t} 간선 ${edges.length} != 예상 ${wantN}`);
}

const total = Number(process.argv[2] ?? 4000);
for (let t = 0; t < total; t += 1) checkOne(t);

const bad = Object.values(fails).some(Boolean);
const lines = Object.entries(fails)
    .map(([k, v]) => `  ${k}: ${v}건${v ? `   예: ${first[k]}` : ''}`);
process.stdout.write(`랜덤 트리 ${total}개 불변식 검사\n${lines.join('\n')}\n`);
process.stdout.write(`${bad ? 'FAIL' : 'PASS'}\n`);
process.exitCode = bad ? 1 : 0;
