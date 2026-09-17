/**
 * 업무프로세스 도식의 좌표 계산 🔑 (순수 함수 · DOM 을 만지지 않는다).
 *
 * 카드 높이는 접힘·펼침·체크항목 수에 따라 달라져 계산식으로 구할 수 없다. 그래서 화면
 * (pages/checklist/flowview.js)이 **카드를 먼저 붙여 높이를 재고** 그 값을 이 모듈에 넘긴다.
 *
 *   1-pass  카드를 DOM 에 붙이고 offsetHeight 측정            (화면이 한다)
 *   2-pass  후위순회로 y, 깊이로 x 를 정한다                   (이 모듈이 한다)
 *             잎  : y = 커서, 커서 += 높이 + gap
 *             부모: y = (첫 자식 y + 마지막 자식 y + 높이) / 2 - 자기높이 / 2
 *
 * 방향은 좌 → 우 다. 형제는 세로로 쌓이고, 잇는 방법만 다르다 -
 * **순차(seq)** 는 부모 → 첫 자식 → 다음 자식 … 으로 이어지는 세로 체인,
 * **갈래(fork)** 는 부모에서 자식마다 따로 뻗는 부채꼴이다 (config.js 의 CHECK_FLOW).
 * **합류(join)** 는 갈래로 벌린 뒤 **자기 다음 형제**로 다시 모으는 것이다. 합류 노드는
 * 레인(x)이 갈래 블록 오른쪽으로 밀리고, 그 뒤 형제들이 밀린 레인을 이어받는다.
 *
 * **번호 채번(`rowNos`·`forkBase`)도 이 모듈에 있다** - 좌표는 웹 도식 전용이지만 번호는
 * 앱(mobile/screens/process.js)도 같은 것을 써야 해서다. steps.js 와 같은 순수 함수 층이라
 * 웹·앱 어느 쪽에서도 쓸 수 있다 (pages/** 와 mobile/** 는 서로 import 하지 않는다).
 */

/* ------------------------------ 번호 채번 (공용) ------------------------------ */

/**
 * 형제 프로세스 줄의 번호 🔑 (순수 함수 · 웹·앱 공용).
 *
 * 형제 줄마다 **정수 슬롯** 1,2,3… 을 매기되 **갈래 부모는 슬롯 2칸을 쓴다** - 자기(N)와
 * 갈래 줄(N+1). 그래서 갈래 하위가 `4.1` `4.2` 로 읽힌다 - 3번 안의 하위가 아니라
 * **다음 단계가 유형별로 쪼개진 것**이다. 갈래 부모의 다음 형제는 합류든 아니든 `N+2` 라
 * 갈래(fork) ↔ 합류(join) 를 토글해도 번호가 흔들리지 않는다.
 *
 * 🔑 **불변식: 결과 배열의 길이와 순서는 입력과 같다** (걸러내지도, 섞지도 않는다).
 * 번호는 경로 캡션 전용이고 체크 대상 판정(`daily`·`isDueOn`·`passes`)·집계와 무관하다.
 *
 * @param {Array} children 형제 프로세스 (원본 순서)
 * @param {{fork?:boolean, base?:string|number, isBranch?:(node)=>boolean}} [opts]
 *   fork     이 줄이 갈래 줄인가 (부모의 `child_flow` 가 `seq` 가 아닌가)
 *   base     갈래 줄의 앞자리. `forkBase(부모 번호)` 로 만든다 (없으면 1)
 *   isBranch 그 형제가 **갈래 부모**인가 - 슬롯을 2칸 쓴다. 순차 줄에서만 본다
 * @returns {Array<number|string>} 정수(순차 `①②③`) 또는 `4.1` 꼴 문자열(갈래)
 */
export function rowNos(children, opts = {}) {
    if (opts.fork) {
        const base = opts.base ?? 1;
        return children.map((_, i) => `${base}.${i + 1}`);
    }
    const isBranch = opts.isBranch ?? ((n) => !!n?.fork);
    let slot = 1;
    return children.map((node) => {
        const no = slot;
        slot += isBranch(node) ? 2 : 1;   // 갈래 부모는 갈래 줄 몫으로 한 칸 더 먹는다
        return no;
    });
}

/**
 * 갈래 줄의 앞자리 🔑 - 부모 번호에서 만든다.
 * 정수 슬롯 N 은 **다음 슬롯**(`N+1`)을 갈래 줄에 내주고, 이미 점 번호인 부모(`4.2` -
 * 갈래 안의 갈래)는 자기 번호 뒤에 한 겹을 더한다(`4.2.1`). 번호가 없는 부모
 * (업무항목·상황)는 1 이라 `1.1` `1.2` 가 된다.
 */
export function forkBase(no) {
    if (no == null) return 1;
    return typeof no === 'number' ? no + 1 : String(no);
}

/**
 * 도식 치수 (px) - 레인 폭·레인 사이 간격·카드 세로 간격.
 * 🔑 `lane` 이 레인 폭의 유일한 출처다. 화면(flowview.layoutCanvas)이 높이를 재기 전에
 * `--pm-lane` CSS 변수로 내려 주므로 CSS 에 폭을 따로 적지 않는다.
 */
export const FLOW_SIZE = { lane: 260, gapX: 56, gapY: 18, pad: 10 };

/** 좌표를 정수로 맞춘다 (SVG 경로 문자열이 길어지지 않게) */
function r(n) {
    return Math.round(n);
}

/**
 * 부모 → 자식 (오른쪽으로) 직교 꺾은선. 중간에서 한 번 꺾는다.
 * @returns {{d:string, head:string}} 선 경로와 화살촉 경로
 */
function elbowPath(a, b) {
    const x1 = r(a.x + a.w);
    const y1 = r(a.y + a.h / 2);
    const x2 = r(b.x);
    const y2 = r(b.y + b.h / 2);
    const mid = r(x1 + (x2 - x1) / 2);
    const d = Math.abs(y1 - y2) < 2
        ? `M${x1} ${y1} H${x2}`
        : `M${x1} ${y1} H${mid} V${y2} H${x2}`;
    return { d, head: `M${x2} ${y2} l-8 -5 v10 z` };
}

/** 형제 → 다음 형제 (아래로) 세로선. 같은 레인이라 곧장 내려간다 */
function downPath(a, b) {
    const x = r(a.x + a.w / 2);
    return { d: `M${x} ${r(a.y + a.h)} V${r(b.y)}`, head: `M${x} ${r(b.y)} l-5 -8 h10 z` };
}

/**
 * 갈래의 **말단** 🔑 - 합류선이 출발하는 노드들.
 * 재귀라 갈래 안의 갈래(중첩)도 규칙을 더하지 않고 풀린다. 말단이 여럿이면 선도 여럿이다.
 * @param {{children?:Array, fork?:boolean, join?:boolean}} node
 * @returns {Array} 하위가 없으면 자기 자신 · 순차면 마지막 하위의 말단 · 갈래/합류면 모든 하위의 말단
 */
export function tails(node) {
    const kids = node.children ?? [];
    if (!kids.length) return [node];
    if (node.fork || node.join) return kids.flatMap(tails);
    return tails(kids[kids.length - 1]);
}

/**
 * 트리 → 좌표.
 * @param {Array<{id:string, height:number, fork:boolean, join:boolean, children:Array}>} roots
 *   fork - **그 노드가 자기 자식들을 잇는 방법**이다 (true 면 갈래)
 *   join - 갈래를 **자기 다음 형제**로 다시 모으는 노드인가 (fork 와 함께 켜진다)
 * @param {{rootFork?:boolean, lane?:number, gapX?:number, gapY?:number}} [opts]
 *   rootFork - 최상위 프로세스들끼리 잇지 않고 갈래로 벌릴지 (업무항목의 연결 방식)
 * @returns {{boxes:Array, edges:Array<{d:string, head:string, fork:boolean, join?:boolean}>,
 *            width:number, height:number}}
 */
export function layoutFlow(roots, opts = {}) {
    const lane = opts.lane ?? FLOW_SIZE.lane;
    const gapX = opts.gapX ?? FLOW_SIZE.gapX;
    const gapY = opts.gapY ?? FLOW_SIZE.gapY;
    const step = lane + gapX;
    const boxes = [];
    const at = new Map();
    let cursor = 0;

    /** 실제로 모을 갈래가 있는 합류 부모인가 (하위가 없으면 합류가 아니다) */
    const joins = (node) => !!node?.join && !!(node.children ?? []).length;

    /** 서브트리가 차지한 범위 - 오른쪽 끝 x 와 맨 위 y */
    const span = (node, acc = { right: 0, top: Infinity }) => {
        const box = at.get(node.id);
        acc.right = Math.max(acc.right, box.x + box.w);
        acc.top = Math.min(acc.top, box.y);
        (node.children ?? []).forEach((c) => span(c, acc));
        return acc;
    };

    /** 자식 묶음을 통째로 아래로 민다 (부모가 자식보다 커서 위로 삐져나올 때) */
    const shift = (node, delta) => {
        (node.children ?? []).forEach((c) => {
            const box = at.get(c.id);
            box.y = r(box.y + delta);
            shift(c, delta);
        });
    };

    /** 자기까지 통째로 민다 (합류 노드를 갈래 가운데로 끌어올릴 때) */
    const moveAll = (node, delta) => {
        const box = at.get(node.id);
        box.y = r(box.y + delta);
        (node.children ?? []).forEach((c) => moveAll(c, delta));
    };

    /**
     * 합류 노드를 **갈래 말단들의 세로 가운데**에 맞춘다.
     * 커서는 건드리지 않는다 - 뒤에 놓일 것들은 갈래 블록 아래에서 시작해야 안전하다.
     * 갈래 블록보다 위로는 올라가지 않게 막는다 (앞 묶음과 겹치지 않도록).
     */
    const centerOnTails = (node, forkNode, blockTop) => {
        const ends = tails(forkNode).map((t) => at.get(t.id));
        const mid = (Math.min(...ends.map((b) => b.y))
            + Math.max(...ends.map((b) => b.y + b.h))) / 2;
        const box = at.get(node.id);
        const up = Math.min(mid - (box.y + box.h / 2), 0);
        moveAll(node, Math.max(up, blockTop - span(node).top));
    };

    /**
     * 형제 한 줄을 차례로 놓는다.
     * 🔑 합류(join) 형제 **다음부터 레인이 오른쪽으로 밀린다.** 합류 노드가 갈래 블록 전체보다
     * 오른쪽에 있어야 합류선이 블록을 가로지르지 않는다. 밀린 레인은 뒤 형제들이 이어받는다.
     * @param {boolean} chained 형제끼리 이어지는 줄인가 (갈래로 벌린 줄이면 합류 대상이 없다)
     */
    const placeRow = (nodes, x, chained) => {
        let cur = x;
        nodes.forEach((node, i) => {
            const from = chained && i && joins(nodes[i - 1]) ? nodes[i - 1] : null;
            const block = from ? span(from) : null;
            if (block) cur = block.right + gapX;
            place(node, cur);
            if (from) centerOnTails(node, from, block.top);
        });
    };

    function place(node, x) {
        const h = Math.max(Number(node.height) || 0, 24);
        const kids = node.children ?? [];
        let y;
        if (!kids.length) {
            y = cursor;
            cursor = y + h + gapY;
        } else {
            const start = cursor;           // 자식 묶음이 시작하는 자리 = 앞 묶음의 아래
            placeRow(kids, x + step, !node.fork && !node.join);
            const first = at.get(kids[0].id);
            const last = at.get(kids[kids.length - 1].id);
            y = (first.y + last.y + last.h) / 2 - h / 2;
            // 🔑 자식 묶음보다 키가 큰 부모는 앞 묶음을 덮는다. 자식을 내려 부모를 제자리에 둔다
            if (y < start) {
                const delta = start - y;
                shift(node, delta);
                cursor += delta;
                y = start;
            }
            cursor = Math.max(cursor, y + h + gapY);
        }
        const box = { id: node.id, x: r(x), y: r(y), w: lane, h: r(h) };
        at.set(node.id, box);
        boxes.push(box);
    }
    placeRow(roots, 0, !opts.rootFork);

    const edges = [];

    /**
     * 갈래 말단들 → 합류 노드. 말단마다 오른쪽으로 빼서 **공용 세로 버스**(합류 레일)에 모으고,
     * 버스에서 합류 노드로 한 번만 꽂는다 (화살촉 1개).
     */
    const joinEdges = (forkNode, target) => {
        const to = at.get(target.id);
        const y2 = r(to.y + to.h / 2);
        const busX = r(to.x - gapX / 2);   // 갈래 블록 전체보다 오른쪽 (placeRow 가 보장한다)
        tails(forkNode).forEach((t) => {
            const b = at.get(t.id);
            const y1 = r(b.y + b.h / 2);
            edges.push({
                d: `M${r(b.x + b.w)} ${y1} H${busX}${y1 === y2 ? '' : ` V${y2}`}`,
                head: '',
                fork: false,
                join: true,
            });
        });
        edges.push({
            d: `M${busX} ${y2} H${r(to.x)}`,
            head: `M${r(to.x)} ${y2} l-8 -5 v10 z`,
            fork: false,
            join: true,
        });
    };

    /** 형제 사슬 - 세로선. 합류 형제 뒤는 세로선 대신 갈래 말단들을 모아 잇는다 */
    const chain = (list) => {
        list.slice(1).forEach((node, i) => {
            if (joins(list[i])) joinEdges(list[i], node);
            else edges.push({ ...downPath(at.get(list[i].id), at.get(node.id)), fork: false });
        });
    };

    const link = (node) => {
        const kids = node.children ?? [];
        if (kids.length) {
            if (node.fork || node.join) {
                kids.forEach((c) => edges.push({ ...elbowPath(at.get(node.id), at.get(c.id)),
                    fork: true }));
            } else {
                edges.push({ ...elbowPath(at.get(node.id), at.get(kids[0].id)), fork: false });
                chain(kids);
            }
        }
        kids.forEach(link);
    };
    roots.forEach(link);
    if (!opts.rootFork) chain(roots);

    const width = boxes.reduce((m, b) => Math.max(m, b.x + b.w), 0) + FLOW_SIZE.pad;
    const height = boxes.reduce((m, b) => Math.max(m, b.y + b.h), 0) + FLOW_SIZE.pad;
    return { boxes, edges, width, height };
}
