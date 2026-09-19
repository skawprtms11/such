/**
 * 업무프로세스 도식의 좌표 계산 🔑 (순수 함수 · DOM 을 만지지 않는다).
 *
 * 카드 높이는 접힘·펼침에 따라 달라져 계산식으로 구할 수 없다. 그래서 화면
 * (pages/checklist/flowview.js)이 **카드를 먼저 붙여 높이를 재고** 그 값을 이 모듈에 넘긴다.
 *
 *   1-pass  레인 폭(`dagCols` → `laneWidth`)을 내려준 뒤 카드를 붙이고 offsetHeight 측정 (화면)
 *   2-pass  열(x)과 진행축(y)을 정한다 (`layoutDag` · 이 모듈)
 *
 * 🔑 **읽는 규칙은 세로다** - 아래로 = 다음 단계 · 옆으로 벌어짐 = 갈래 · 다시 모임 = 합류.
 *
 * 🔑 **모델은 간선 테이블(DAG) 하나다.** 갈래는 「같은 from 에서 나가는 간선 여럿」, 합류는
 * 「같은 to 로 들어오는 간선 여럿」이라 「갈래 A 는 3단계 뒤에서, B 는 바로 합류」 같은 흐름이
 * 그대로 표현된다. 순환은 데이터 계층(db.addProcessEdge)이 막는다.
 *
 * **번호 채번(`flowNos`)도 이 모듈에 있다** - 좌표는 웹 도식 전용이지만 번호는 앱도 같은 것을
 * 써야 해서다. steps.js 와 같은 순수 함수 층이라 웹·앱 어느 쪽에서도 쓸 수 있다.
 */

/* ------------------------------ 좌표 (웹 도식 전용) ------------------------------ */

/**
 * 도식 치수 (px) 🔑 - **새 DAG 모델의 유일한 출처**다.
 * 🔑 `lane` 은 레인 폭의 유일한 출처다 - 화면(flowview.layoutCanvas)이 높이를 재기 **전에**
 * `--pm-lane` CSS 변수로 내려 주므로 CSS 에 폭을 따로 적지 않는다. 폭은 가용폭에 맞춰
 * `laneMin`~`laneMax` 사이에서 정한다 (`laneWidth`).
 *   gapY   층 사이 세로 간격 (갈래·합류 버스가 이 틈 가운데를 지난다)
 *   gapX   열 사이 간격 (들여쓰기가 없어 이 값이 그대로 쓰인다)
 */
export const DAG_SIZE = {
    lane: 240, laneMin: 200, laneMax: 260, gapX: 40, gapY: 56, pad: 10,
};

/**
 * 조건 라벨 칩의 치수 🔑 - **겹침을 계산으로 막으려면 폭을 알아야 한다.**
 * 글꼴 폭을 재지 않고 글자 수로 어림하고, 화면(flowview)이 이 폭을 칩에 그대로 입혀
 * (`width` · 넘치면 말줄임) 계산과 실제 칩이 어긋나지 않게 한다.
 *   char 글자 하나의 폭 · padX 좌우 여백+테두리 · h 높이 · gap 칩 사이 최소 간격
 */
export const LABEL_SIZE = { char: 7, padX: 18, h: 18, gap: 6, max: 160 };

/** 라벨 칩의 폭 (글자 수로 어림 · 최대폭에서 잘린다) */
function labelW(text) {
    const n = String(text ?? '').length;
    return Math.min(LABEL_SIZE.max, LABEL_SIZE.padX + LABEL_SIZE.char * Math.max(n, 1));
}

/** 좌표를 정수로 맞춘다 (SVG 경로 문자열이 길어지지 않게) */
function r(n) {
    return Math.round(n);
}

/**
 * 가용폭에 맞춘 레인 폭 🔑 - 열이 화면에 들어오면 꽉 채우고, 안 들어오면 최소폭에서 멈춘다
 * (그때는 가로 스크롤). 갈래 수에 따라 레인 폭을 다르게 주지는 않는다.
 *
 * 🔑 **열 수는 `dagCols`(더미 포함 최대 층 폭)로 센다** - `layoutDag` 가 자리를 잡는 열과
 * 같은 수여야 카드가 계산한 자리에서 밀리지 않는다. 들여쓰기가 없어져 간격은 `gapX` 그대로이고,
 * **좌표 계산(`layoutDag`)에 넘길 값과 같은 것을 넘겨야 한다** (기본값도 `DAG_SIZE.gapX` 로 같다).
 * @param {number} avail 도식이 쓸 수 있는 폭 (.pm-canvas 의 clientWidth · 인쇄는 A4 폭)
 * @param {number} count 열 수 (`dagCols` 결과)
 * @param {{gapX?:number}} [opts] 좌표 계산에 넘길 값과 **같은 것을 넘긴다**
 *   (폭 계산과 좌표 계산이 다른 간격을 쓰면 선이 카드에서 떨어진다)
 */
export function laneWidth(avail, count, opts = {}) {
    const n = Math.max(1, count);
    const gap = Number(opts.gapX ?? DAG_SIZE.gapX) || 0;
    const room = Math.floor(((Number(avail) || 0) - gap * (n - 1)) / n);
    return Math.min(DAG_SIZE.laneMax, Math.max(DAG_SIZE.laneMin, room));
}

/* ------------------------------ DAG (간선 테이블 기반) ------------------------------ */

/** 여러 수의 중위값 (빈 배열이면 null) */
function median(ns) {
    if (!ns.length) return null;
    const s = [...ns].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 간선 목록 → 층·층 내 순서 🔑 (Sugiyama-lite · 측정값이 필요 없는 순수 계산).
 * `flowNos`(번호)와 `layoutDag`(좌표)가 **같은 결과**를 써야 번호와 열이 어긋나지 않는다.
 *
 *   층      Kahn 위상정렬로 최장경로. `layer(v) = 1 + max(layer(pred))` · 시작 = 1
 *   더미    span > 1 인 간선은 지나는 층마다 **열을 예약**한다 - 카드 관통이 구조적으로 불가능
 *   순서    시작 노드 DFS(같은 from 은 `sort_order` 순) → median 정렬 2왕복 (stable sort)
 *   pin     같은 from 에서 갈라진 형제는 한 덩이로 움직인다 - 자동 정렬이 사용자 순서를 덮지 않는다
 *
 * @param {Array<{id:string}>} nodes
 * @param {Array<{id?:string, from:string|null, to:string, sort_order?:number}>} edges
 *   `from` 이 null 인 행은 **시작 표시**라 그리지 않는다 (출발 카드가 없다)
 */
function arrange(nodes, edges) {
    const list = (nodes ?? []).filter((n) => n && n.id != null);
    const ids = new Set(list.map((n) => n.id));
    const rows = (edges ?? []).filter((e) => e && e.from != null
        && ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
    /* 시작 간선(from null)은 선행자가 아니라 **진입 노드의 순서**다 - 버리면 갈래 순서를
       바꿔도 1층이 그대로라 사용자가 정한 순서가 사라진다 (db.reorderEdges(null, ...)) */
    const startSort = new Map();
    (edges ?? []).forEach((e) => {
        if (!e || e.from != null || !ids.has(e.to)) return;
        const so = Number(e.sort_order ?? 0) || 0;
        startSort.set(e.to, Math.min(startSort.get(e.to) ?? Infinity, so));
    });
    const pred = new Map(list.map((n) => [n.id, []]));
    const succ = new Map(list.map((n) => [n.id, []]));
    rows.forEach((e) => {
        pred.get(e.to).push(e);
        succ.get(e.from).push(e);
    });
    // 같은 from 에서 나가는 순서는 사용자가 정한다 (Array.sort 는 stable)
    succ.forEach((out) => out.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));

    const layer = new Map();
    const indeg = new Map(list.map((n) => [n.id, pred.get(n.id).length]));
    const queue = list.filter((n) => !indeg.get(n.id)).map((n) => n.id);
    const done = new Set(queue);
    queue.forEach((id) => layer.set(id, 1));
    for (let i = 0; i < queue.length; i += 1) {
        const id = queue[i];
        succ.get(id).forEach((e) => {
            layer.set(e.to, Math.max(layer.get(e.to) ?? 1, layer.get(id) + 1));
            indeg.set(e.to, indeg.get(e.to) - 1);
            if (!indeg.get(e.to)) {
                done.add(e.to);
                queue.push(e.to);
            }
        });
    }
    // 순환은 데이터 계층이 막지만, 남으면 마지막 층에 격리하고 알린다 (그 간선은 그리지 않는다)
    const stuck = list.filter((n) => !done.has(n.id));
    const solved = [...done].reduce((m, id) => Math.max(m, layer.get(id)), 0);
    stuck.forEach((n) => layer.set(n.id, solved + 1));
    const maxL = list.length ? Math.max(...list.map((n) => layer.get(n.id))) : 0;

    const rowsAt = Array.from({ length: maxL }, () => []);
    const byKey = new Map();
    const add = (L, item) => {
        rowsAt[L - 1].push(item);
        byKey.set(item.key, item);
    };
    const seen = new Set();
    const walk = (id) => {
        if (seen.has(id)) return;
        seen.add(id);
        add(layer.get(id), { key: id, node: id });
        succ.get(id).forEach((e) => walk(e.to));
    };
    [...list.filter((n) => !pred.get(n.id).length)]
        .sort((a, b) => (startSort.get(a.id) ?? 0) - (startSort.get(b.id) ?? 0))
        .forEach((n) => walk(n.id));
    list.forEach((n) => walk(n.id));          // 순환·미도달 노드도 자리를 받는다

    const ri = new Map(rows.map((e, i) => [e, i]));
    const dkey = (e, L) => `dummy:${ri.get(e)}@${L}`;
    const span = (e) => layer.get(e.to) - layer.get(e.from);
    let dummies = 0;
    rows.forEach((e) => {
        for (let L = layer.get(e.from) + 1; L < layer.get(e.to); L += 1) {
            add(L, { key: dkey(e, L), edge: e });
            dummies += 1;
        }
    });

    /** 간선 e 가 층 L 에서 지나는 항목의 키 (양 끝은 실노드, 가운데는 더미) */
    const atLayer = (e, L) => {
        if (L === layer.get(e.from)) return e.from;
        if (L === layer.get(e.to)) return e.to;
        return dkey(e, L);
    };
    const up = new Map();      // key → 위 층 이웃 키 목록
    const down = new Map();    // key → 아래 층 이웃 키 목록
    const tie = (key, side, other) => {
        const m = side === 'up' ? up : down;
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(other);
    };
    rows.forEach((e) => {
        if (span(e) < 1) return;
        for (let L = layer.get(e.from); L < layer.get(e.to); L += 1) {
            tie(atLayer(e, L), 'down', atLayer(e, L + 1));
            tie(atLayer(e, L + 1), 'up', atLayer(e, L));
        }
    });

    /* pin - 같은 from 에서 갈라진 형제(더미 포함)는 sort_order 순서를 지킨 한 덩이다.
       들어오는 간선이 그 from 하나뿐인 항목만 묶는다 (합류 노드는 덩이가 둘이 될 수 없다) */
    const pinOf = new Map();
    const groups = new Map();
    list.forEach((n) => {
        const out = succ.get(n.id).filter((e) => span(e) >= 1);
        if (out.length < 2) return;
        const members = out
            .map((e) => atLayer(e, layer.get(n.id) + 1))
            .filter((key) => byKey.get(key)?.edge || pred.get(key)?.length === 1)
            .filter((key) => !pinOf.has(key));
        if (members.length < 2) return;
        groups.set(n.id, members);
        members.forEach((key) => pinOf.set(key, n.id));
    });

    const pos = new Map();
    const reindex = () => rowsAt.forEach((items) => items.forEach((it, i) => pos.set(it.key, i)));
    reindex();
    /** 층 하나를 median 으로 다시 늘어놓는다 (pin 덩이는 통째로 움직인다) */
    const sortLayer = (idx, side) => {
        const items = rowsAt[idx];
        if (items.length < 2) return;
        const taken = new Set();
        const units = [];
        items.forEach((it) => {
            if (taken.has(it.key)) return;
            const gid = pinOf.get(it.key);
            const keys = gid
                ? groups.get(gid).filter((k) => items.includes(byKey.get(k)))
                : [it.key];
            keys.forEach((k) => taken.add(k));
            units.push(keys);
        });
        const keyed = units.map((keys, i) => {
            const ns = keys.flatMap((k) => ((side === 'up' ? up : down).get(k) ?? [])
                .map((nk) => pos.get(nk)).filter((v) => v != null));
            const m = median(ns);
            return { keys, i, m: m == null ? pos.get(keys[0]) : m };
        });
        keyed.sort((a, b) => (a.m - b.m) || (a.i - b.i));
        rowsAt[idx] = keyed.flatMap((k) => k.keys.map((key) => byKey.get(key)));
        reindex();
    };
    for (let pass = 0; pass < 2; pass += 1) {
        for (let i = 1; i < maxL; i += 1) sortLayer(i, 'up');           // 아래로 (preds 기준)
        for (let i = maxL - 2; i >= 0; i -= 1) sortLayer(i, 'down');    // 위로 (succs 기준)
    }

    const col = new Map();
    rowsAt.forEach((items) => items.forEach((it, i) => col.set(it.key, i)));
    const layers = rowsAt.map((items) => items.filter((it) => it.node).map((it) => it.node));
    return {
        list, rows, layer, col, rowsAt, layers, maxL, dummies, dkey, span,
        cyclic: stuck.length > 0,
    };
}

/**
 * 마지막 `arrange` 결과 한 벌 🔑 - `dagCols`(폭 계산)와 `layoutDag`(좌표)가 **같은 배열**로
 * 연달아 불리므로(flowview.layoutCanvas) 같은 계산을 두 번 하지 않는다.
 * 배열 **레퍼런스**가 같을 때만 재사용한다 - 순수 함수라 같은 입력이면 같은 결과다.
 * (카드 높이는 `arrange` 가 보지 않는다. `layoutDag` 가 그때그때 노드에서 읽으므로
 *  1-pass 로 높이를 채워 넣어도 캐시가 틀리지 않는다)
 */
let memo = { nodes: null, edges: null, out: null };

function arranged(nodes, edges) {
    if (memo.nodes === nodes && memo.edges === edges) return memo.out;
    const out = arrange(nodes, edges);
    memo = { nodes, edges, out };
    return out;
}

/**
 * 층·번호 🔑 (순수 함수 · 웹·앱 공용 · 측정값이 필요 없다).
 *
 * 층에 노드가 **1개면 정수**(`'3'`), **2개 이상이면 `층.k`**(`'4.1'` - k 는 층 내 좌→우 순서)다.
 * 합류 노드는 `max(pred 층) + 1` 이라 갈래 뒤에 저절로 놓인다 - 트리 시절의 「슬롯 2칸」 같은
 * 보정이 필요 없다.
 *
 * @param {Array<{id:string}>} nodes
 * @param {Array<{from:string|null, to:string, sort_order?:number}>} edges
 * @returns {{layer:Object, no:Object, order:Array, layers:Array<Array>, cyclic:boolean}}
 *   order - 읽는 순서(층 → 층 내 좌→우) · layers - 층별 노드 id
 */
export function flowNos(nodes, edges) {
    const a = arranged(nodes, edges);
    const layer = {};
    const no = {};
    a.layers.forEach((row, i) => row.forEach((id, k) => {
        layer[id] = i + 1;
        no[id] = row.length > 1 ? `${i + 1}.${k + 1}` : `${i + 1}`;
    }));
    return { layer, no, order: a.layers.flat(), layers: a.layers, cyclic: a.cyclic };
}

/**
 * 도식 전체의 **열 수** 🔑 - 더미 열까지 센다 (긴 간선이 예약한 열도 자리를 차지한다).
 * 측정값이 필요 없으므로 카드 높이를 재기 **전에** 불러 레인 폭(`laneWidth`)을 정한다.
 */
export function dagCols(nodes, edges) {
    const a = arranged(nodes, edges);
    return Math.max(1, ...a.rowsAt.map((items) => items.length));
}

/** 꼭짓점 목록에서 같은 점·일직선 위의 중간점을 걷어낸다 (경로 문자열이 짧아진다) */
function simplify(pts) {
    const out = [];
    pts.forEach((p) => {
        const last = out[out.length - 1];
        if (last && last[0] === p[0] && last[1] === p[1]) return;
        const prev = out[out.length - 2];
        if (prev && ((prev[0] === last[0] && last[0] === p[0])
            || (prev[1] === last[1] && last[1] === p[1]))) out.pop();
        out.push(p);
    });
    return out;
}

/** 꼭짓점 목록 → `M·V·H` 경로 (다른 명령은 쓰지 않는다 - 검사기 파서가 실패로 센다) */
function pathOf(pts) {
    let [px, py] = pts[0];
    const out = [`M${px} ${py}`];
    pts.slice(1).forEach(([x, y]) => {
        if (y !== py) out.push(`V${y}`);
        if (x !== px) out.push(`H${x}`);
        px = x;
        py = y;
    });
    return out.join(' ');
}

/**
 * 조건 라벨 자리 🔑 - **갈래마다 다른 자리**여야 한다.
 * 예전에는 「출발 카드 중심 x · 틈 가운데 y」라, 같은 from 에서 나가는 간선은 라벨이 모두
 * 같은 점에 겹쳐 뒤의 칩을 누를 수 없었다 (조건 라벨·갈래 순서·연결 끊기를 못 열었다).
 *
 * 그래서 **그 갈래가 내려가는 열**(버스에서 내려오는 세로 구간)의 x 를 원하는 자리로 잡고,
 * 같은 틈에서 자리가 겹치는 칩은 **오른쪽으로 밀어** 겹침을 없앤다.
 * 다른 틈끼리는 카드 띠(최소 24px)가 사이에 있어 칩 높이(18px)로는 닿지 않는다.
 * @param {Array} wants `{gap, cx, text, put}` - gap 은 틈 번호(= 출발 카드의 층)
 */
function placeLabels(wants, gapMid) {
    const byGap = new Map();
    wants.forEach((w) => {
        if (!byGap.has(w.gap)) byGap.set(w.gap, []);
        byGap.get(w.gap).push(w);
    });
    byGap.forEach((list, L) => {
        const cy = gapMid(L);
        let edge = -Infinity;
        [...list].sort((a, b) => (a.cx - b.cx) || (a.i - b.i)).forEach((w) => {
            const w0 = labelW(w.text);
            const x = Math.max(w.cx - w0 / 2, edge);
            edge = x + w0 + LABEL_SIZE.gap;
            w.put({
                x: r(x), y: r(cy - LABEL_SIZE.h / 2), w: w0, h: LABEL_SIZE.h, text: w.text,
            });
        });
    });
}

/**
 * 간선 테이블 → 좌표 🔑 (2-pass - 화면이 카드 높이를 재서 넘긴다).
 *
 *   x  `col * (lane + gapX)` - 카드 폭이 모두 같아 **이산값**이다 (들여쓰기가 없다)
 *   y  층 띠를 쌓는다. `yTop(L) = yTop(L-1) + 층 내 최대 높이 + gapY`
 *
 * 모든 간선은 **출발 = 카드 바닥 · 도착 = 카드 천장**이고 꺾임은 **층 사이 틈 가운데**에서만
 * 일어난다 (기준이 하나여야 「선이 허공에서 시작」 같은 결함이 다시 나지 않는다).
 * 같은 from 에서 나가는 간선은 같은 점에서 출발해 같은 틈에서 갈라지고(갈래 버스),
 * 같은 to 로 들어오는 간선은 같은 틈에 모여 카드 천장 한 점에 꽂힌다(합류 버스 · 화살촉 1개).
 * span > 1 인 간선은 `arrange` 가 예약한 **더미 열**로 내려오므로 카드를 관통할 수 없다.
 *
 * @param {Array<{id:string, height:number}>} nodes
 * @param {Array<{id:string, from:string|null, to:string, label?:string,
 *                sort_order?:number}>} edges
 * @param {{lane?:number, gapX?:number, gapY?:number}} [opts]
 * @returns {{boxes:Object, edges:Array, width:number, height:number,
 *            layers:Array<Array>, cols:Object, dummies:number}}
 */
export function layoutDag(nodes, edges, opts = {}) {
    const lane = Number(opts.lane) || DAG_SIZE.lane;
    const gapX = Number(opts.gapX ?? DAG_SIZE.gapX) || 0;
    // 틈이 0 이면 버스와 라벨이 카드 경계에 붙어 읽을 수 없다
    const gapY = Math.max(Number(opts.gapY ?? DAG_SIZE.gapY) || 0, 8);
    const a = arranged(nodes, edges);
    const hOf = new Map(a.list.map((n) => [n.id, Math.max(Number(n.height) || 0, 24)]));
    const pitch = lane + gapX;
    const cx = (key) => r(a.col.get(key) * pitch + lane / 2);
    const rowH = a.rowsAt.map((items) => items
        .reduce((m, it) => Math.max(m, it.node ? hOf.get(it.node) : 0), 24));
    const yTop = rowH.map(() => 0);
    rowH.forEach((_h, i) => { if (i) yTop[i] = yTop[i - 1] + rowH[i - 1] + gapY; });
    /** 층 L 아래 틈의 가운데 - 버스는 이 높이에만 있다 (카드 띠를 건드리지 않는다) */
    const gapMid = (L) => r(yTop[L - 1] + rowH[L - 1] + gapY / 2);

    const boxes = {};
    const cols = {};
    a.layers.forEach((row, i) => row.forEach((id) => {
        cols[id] = a.col.get(id);
        boxes[id] = { x: r(a.col.get(id) * pitch), y: r(yTop[i]), w: lane, h: r(hOf.get(id)) };
    }));

    let lineX = 0;
    const wants = [];
    const out = a.rows.map((e) => {
        if (a.span(e) < 1) return null;          // 순환 격리로 뒤로 가는 간선은 그리지 않는다
        const from = boxes[e.from];
        const to = boxes[e.to];
        const pts = [[cx(e.from), from.y + from.h]];
        const last = () => pts[pts.length - 1][0];
        for (let L = a.layer.get(e.from); L < a.layer.get(e.to); L += 1) {
            const next = L + 1 === a.layer.get(e.to) ? e.to : a.dkey(e, L + 1);
            pts.push([last(), gapMid(L)]);
            pts.push([cx(next), gapMid(L)]);
        }
        pts.push([last(), to.y]);
        const trim = simplify(pts);
        lineX = trim.reduce((m, p) => Math.max(m, p[0]), lineX);
        const L0 = a.layer.get(e.from);
        const row = {
            id: e.id,
            from: e.from,
            to: e.to,
            path: pathOf(trim),
            head: `M${cx(e.to)} ${to.y} l-5 -8 h10 z`,
            label: null,
        };
        if (e.label) {
            wants.push({
                gap: L0,
                cx: cx(L0 + 1 === a.layer.get(e.to) ? e.to : a.dkey(e, L0 + 1)),
                text: String(e.label),
                i: wants.length,
                put: (box) => { row.label = box; },
            });
        }
        return row;
    }).filter(Boolean);
    placeLabels(wants, gapMid);

    const right = Object.values(boxes).reduce((m, b) => Math.max(m, b.x + b.w), 0);
    // 라벨 칩은 오른쪽으로 밀릴 수 있어 폭에 함께 넣는다 (밀린 칩이 잘리지 않게)
    const labelX = out.reduce((m, e) => Math.max(m, e.label ? e.label.x + e.label.w : 0), 0);
    const width = r(Math.max(right, labelX, out.length ? lineX + lane / 2 : 0)) + DAG_SIZE.pad;
    const height = Object.values(boxes).reduce((m, b) => Math.max(m, b.y + b.h), 0) + DAG_SIZE.pad;
    return { boxes, edges: out, width, height, layers: a.layers, cols, dummies: a.dummies };
}
