/**
 * 업무프로세스 도식의 좌표 계산 🔑 (순수 함수 · DOM 을 만지지 않는다).
 *
 * 카드 높이는 접힘·펼침·체크항목 수에 따라 달라져 계산식으로 구할 수 없다. 그래서 화면
 * (pages/checklist/flowview.js)이 **카드를 먼저 붙여 높이를 재고** 그 값을 이 모듈에 넘긴다.
 *
 *   1-pass  레인 폭을 내려준 뒤 카드를 DOM 에 붙이고 offsetHeight 측정   (화면이 한다)
 *   2-pass  열(x)과 진행축(y)을 정한다                                  (이 모듈이 한다)
 *
 * 🔑 **읽는 규칙은 세로다** - 아래로 = 다음 단계 · 오른쪽으로 벌어짐 = 갈래 ·
 * 들여쓰기 = 순차 하위. 진행 방향이 위 → 아래라 갈래가 「부모 안의 하위」로 읽히지 않는다.
 *
 *   크로스축(x)  `cols(node)` 가 서브트리의 **열 수**를 센다 - 갈래는 합, 순차는 최대.
 *                측정값이 필요 없는 순수 정수 계산이라 **높이를 재기 전에** 총 열 수를 알 수 있고,
 *                거기서 레인 폭(`laneWidth`)을 정한다
 *   진행축(y)    선위순회로 `y = 부모.bottom + gapY` 또는 `앞 서브트리.bottom + gapY`
 *
 * 🔑 **줄기(main spine)는 왼쪽 첫 열에 고정한다.** 갈래 부모를 갈래 블록 가운데로 맞추면
 * 줄기가 지그재그로 흔들려 세로 스캔이 깨진다. 부모가 항상 자식보다 위에 있어
 * 예전(좌→우)의 `cursor`·`shift`·`centerOnTails` 같은 보정이 필요 없다.
 *
 * **합류(join)** 는 갈래로 벌린 뒤 **자기 다음 형제**로 다시 모으는 것이다 (config.js 의
 * CHECK_FLOW). 합류 노드는 갈래 블록 전체 **아래**에 놓이고, 말단들이 가로 버스로 모인다.
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

/* ------------------------------ 좌표 (웹 도식 전용) ------------------------------ */

/**
 * 도식 치수 (px).
 * 🔑 `lane` 은 레인 폭의 유일한 출처다 - 화면(flowview.layoutCanvas)이 높이를 재기 **전에**
 * `--pm-lane` CSS 변수로 내려 주므로 CSS 에 폭을 따로 적지 않는다. 폭은 가용폭에 맞춰
 * `laneMin`~`laneMax` 사이에서 정한다 (`laneWidth`).
 *   gapY   카드 사이 세로 간격 (갈래·합류 버스가 이 틈 가운데를 지난다)
 *   gapX   레인 사이 간격 (🔑 `indent * 2 + clear` 이상이어야 한다 - `colGap` 참고)
 *   indent 순차 하위의 들여쓰기 (2단계에서 캡 - `indent * 2`)
 *   clear  들여쓴 카드와 옆 열 카드 사이에 남겨 둘 최소 여백
 */
export const FLOW_SIZE = {
    lane: 240, laneMin: 200, laneMax: 260, gapX: 56, gapY: 56, indent: 24, clear: 8, pad: 10,
};

/**
 * 열 사이 간격 🔑 - **들여쓰기 상한보다 반드시 넓다.**
 *
 * 카드 폭은 들여쓰기와 무관하게 레인 폭 그대로라 2단 들여쓴 카드는 열 오른쪽으로
 * `indent * 2` 만큼 삐져나온다. `gapX` 가 그보다 좁으면 옆 열 카드와 겹친다
 * (실제로 `gapX 40` · 들여쓰기 상한 `48` 이라 8px 겹쳤다 - 「V2 열 독점」 위반).
 * 두 값을 따로 두면 한쪽만 고쳐 같은 버그가 되살아나므로 **간격을 여기서 한 번 더 올려**
 * 코드로 보장한다. 레인 폭 계산(`laneWidth`)과 좌표 계산(`layoutFlow`)이 같은 값을 쓴다.
 *
 * @param {number} [gapX] 원하는 간격
 * @param {number} [step] 들여쓰기 한 단계
 * @returns {number} `max(gapX, step * 2 + clear)`
 */
export function colGap(gapX = FLOW_SIZE.gapX, step = FLOW_SIZE.indent) {
    return Math.max(Number(gapX) || 0, (Number(step) || 0) * 2 + FLOW_SIZE.clear);
}

/** 좌표를 정수로 맞춘다 (SVG 경로 문자열이 길어지지 않게) */
function r(n) {
    return Math.round(n);
}

/**
 * 서브트리가 먹는 **열 수** 🔑 - 갈래는 합(나란히), 순차 하위는 최대(같은 열).
 * 측정값이 필요 없는 순수 정수 계산이라 카드 높이를 재기 전에 부를 수 있다.
 */
export function cols(node) {
    const kids = node.children ?? [];
    if (!kids.length) return 1;
    if (node.fork || node.join) return kids.reduce((n, k) => n + cols(k), 0);
    return Math.max(...kids.map(cols));
}

/**
 * 도식 전체의 열 수 - 루트가 갈래면 합, 아니면 최대.
 * @param {boolean} rootFork 최상위 프로세스들끼리 갈래로 벌리는가 (업무항목의 연결 방식)
 */
export function flowCols(roots, rootFork = false) {
    if (!roots.length) return 1;
    return rootFork
        ? roots.reduce((n, k) => n + cols(k), 0)
        : Math.max(...roots.map(cols));
}

/**
 * 가용폭에 맞춘 레인 폭 🔑 - 열이 화면에 들어오면 꽉 채우고, 안 들어오면 최소폭에서 멈춘다
 * (그때는 가로 스크롤). 갈래 수에 따라 레인 폭을 다르게 주지는 않는다.
 * @param {number} avail 도식이 쓸 수 있는 폭 (.pm-canvas 의 clientWidth · 인쇄는 A4 폭)
 * @param {number} count 열 수 (flowCols 결과)
 * @param {{gapX?:number, indent?:number}} [opts] `layoutFlow` 에 넘길 값과 **같은 것을 넘긴다**
 *   (폭 계산과 좌표 계산이 다른 간격을 쓰면 선이 카드에서 떨어진다)
 */
export function laneWidth(avail, count, opts = {}) {
    const n = Math.max(1, count);
    const gap = colGap(opts.gapX ?? FLOW_SIZE.gapX, opts.indent ?? FLOW_SIZE.indent);
    const room = Math.floor(((Number(avail) || 0) - gap * (n - 1)) / n);
    return Math.min(FLOW_SIZE.laneMax, Math.max(FLOW_SIZE.laneMin, room));
}

/**
 * 아래로 잇는 직교 꺾은선 - 부모 → 첫 하위, 앞 형제 → 다음 형제에 함께 쓴다.
 * 들여쓰기가 다르면 **틈 가운데에서** 옆으로 한 번 꺾고, 같은 x 면 그냥 곧게 내려간다.
 * @returns {{d:string, head:string}} 선 경로와 화살촉 경로
 */
function elbowPath(a, b) {
    const x1 = r(a.x + a.w / 2);
    const y1 = r(a.y + a.h);
    const x2 = r(b.x + b.w / 2);
    const y2 = r(b.y);
    const mid = r(y1 + (y2 - y1) / 2);
    const d = Math.abs(x1 - x2) < 2
        ? `M${x1} ${y1} V${y2}`
        : `M${x1} ${y1} V${mid} H${x2} V${y2}`;
    return { d, head: `M${x2} ${y2} l-5 -8 h10 z` };
}

/**
 * 갈래의 **말단** 🔑 - 합류선이 출발하는 노드들.
 * 재귀라 갈래 안의 갈래(중첩)도 규칙을 더하지 않고 풀린다. 말단이 여럿이면 선도 여럿이다.
 * 축을 모르는 순수 트리 함수라 세로 전환에도 그대로 쓴다.
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
 * @param {{rootFork?:boolean, lane?:number, gapX?:number, gapY?:number, indent?:number}} [opts]
 *   rootFork - 최상위 프로세스들끼리 잇지 않고 갈래로 벌릴지 (업무항목의 연결 방식)
 * @returns {{boxes:Array<{id,x,y,w,h,indent}>,
 *            edges:Array<{d:string, head:string, fork:boolean, join?:boolean}>,
 *            width:number, height:number}}
 */
export function layoutFlow(roots, opts = {}) {
    const lane = opts.lane ?? FLOW_SIZE.lane;
    const gapY = opts.gapY ?? FLOW_SIZE.gapY;
    const step = opts.indent ?? FLOW_SIZE.indent;
    const maxIndent = step * 2;          // 들여쓰기는 2단계에서 멈춘다 (오른쪽으로 새지 않게)
    const gapX = colGap(opts.gapX ?? FLOW_SIZE.gapX, step);   // 반드시 maxIndent 보다 넓다
    const boxes = [];
    const at = new Map();
    const colAt = new Map();      // 카드가 놓인 열 번호 (blockNextEdge 가 같은 열의 카드를 찾는다)

    const kidsOf = (node) => node.children ?? [];
    /** 실제로 모을 갈래가 있는 합류 부모인가 (하위가 없으면 합류가 아니다) */
    const joins = (node) => !!node?.join && !!kidsOf(node).length;
    const colX = (i) => i * (lane + gapX);
    /**
     * 순차 줄의 **끝 카드** 🔑 - 다음 형제는 여기서 이어 간다. 카드 사이를 가로지르지 않게
     * 하위 줄의 마지막 카드에서 출발하는 것이다.
     *
     * 갈래(fork·join)가 끼면 끝이 여럿이라 `null` 이다 - 갈래 부모 자신뿐 아니라
     * **마지막 하위가 갈래인 순차 부모**도 그렇다. 🔑 `null` 일 때 **부모 카드에서 곧장
     * 내려서는 안 된다** - 그 사이에 있는 갈래 카드들을 관통한다 (SVG 가 카드 뒤에 깔려
     * 화면에서는 「부모 → 갈래 첫 카드 → 다음 형제」 로 잘못 읽힌다).
     * 합류면 `joinEdges`, 아니면 `blockNextEdge` 로 **서브트리 전체 아래에서** 잇는다.
     */
    const spineTail = (node) => {
        const kids = kidsOf(node);
        if (!kids.length) return node;
        if (node.fork || node.join) return null;
        return spineTail(kids[kids.length - 1]);
    };

    /** 서브트리에서 가장 아래 끝 (다음 형제가 시작할 자리) */
    const bottomOf = (node) => kidsOf(node)
        .reduce((m, k) => Math.max(m, bottomOf(k)), at.get(node.id).y + at.get(node.id).h);

    /**
     * 형제 한 줄을 위에서 아래로 놓는다.
     * 다음 형제는 **앞 서브트리 전체 아래**에서 시작한다 - 합류 노드(갈래 부모의 다음 형제)도
     * 같은 규칙이라 갈래 블록 전체 아래에 놓인다. 열과 들여쓰기는 줄 내내 그대로다.
     */
    const placeRow = (nodes, col, yTop, indent) => {
        let y = yTop;
        nodes.forEach((node) => {
            place(node, col, y, indent);
            y = bottomOf(node) + gapY;
        });
    };

    function place(node, col, y, indent) {
        const h = Math.max(Number(node.height) || 0, 24);
        const box = { id: node.id, x: r(colX(col) + indent), y: r(y), w: lane, h: r(h), indent };
        at.set(node.id, box);
        colAt.set(node.id, col);
        boxes.push(box);
        const kids = kidsOf(node);
        if (!kids.length) return;
        const childTop = box.y + box.h + gapY;
        if (node.fork || node.join) {
            // 갈래는 각자 열 블록을 차지한다 (형제끼리 잇지 않으므로 들여쓰기도 없다)
            let c = col;
            kids.forEach((k) => {
                place(k, c, childTop, 0);
                c += cols(k);
            });
        } else {
            placeRow(kids, col, childTop, Math.min(indent + step, maxIndent));
        }
    }

    if (opts.rootFork) {
        let c = 0;
        roots.forEach((node) => {
            place(node, c, 0, 0);
            c += cols(node);
        });
    } else {
        placeRow(roots, 0, 0, 0);
    }

    const edges = [];

    /**
     * 부모 → 갈래들. 부모 아래 **가로 버스**(틈 가운데)까지 내려가 갈래마다 아래로 꺾는다.
     * 버스는 카드 사이 틈 안에만 있어 카드를 가로지르지 않는다.
     */
    const forkEdges = (node, kids) => {
        const from = at.get(node.id);
        const x1 = r(from.x + from.w / 2);
        const busY = r(from.y + from.h + gapY / 2);
        edges.push({ d: `M${x1} ${r(from.y + from.h)} V${busY}`, head: '', fork: true });
        kids.forEach((k) => {
            const b = at.get(k.id);
            const x2 = r(b.x + b.w / 2);
            edges.push({
                d: `M${x1} ${busY}${x1 === x2 ? '' : ` H${x2}`} V${r(b.y)}`,
                head: `M${x2} ${r(b.y)} l-5 -8 h10 z`,
                fork: true,
            });
        });
    };

    /**
     * 갈래 말단들 → 합류 노드. 말단마다 아래로 빼서 **공용 가로 버스**(합류 노드 위 틈 가운데)에
     * 모으고, 버스에서 합류 노드로 한 번만 꽂는다 (화살촉 1개).
     */
    const joinEdges = (forkNode, target) => {
        const to = at.get(target.id);
        const x2 = r(to.x + to.w / 2);
        const busY = r(to.y - gapY / 2);
        tails(forkNode).forEach((t) => {
            const b = at.get(t.id);
            const x1 = r(b.x + b.w / 2);
            edges.push({
                d: `M${x1} ${r(b.y + b.h)} V${busY}${x1 === x2 ? '' : ` H${x2}`}`,
                head: '',
                fork: false,
                join: true,
            });
        });
        edges.push({
            d: `M${x2} ${busY} V${r(to.y)}`,
            head: `M${x2} ${r(to.y)} l-5 -8 h10 z`,
            fork: false,
            join: true,
        });
    };

    /**
     * 서브트리에서 **자기 열의 가장 아래 카드** 🔑 - `blockNextEdge` 의 출발 카드.
     *
     * 서브트리 바닥(`bottomOf`)은 갈래로 벌어진 **다른 열**의 카드일 수 있어, 그 y 에는
     * 부모 열에 아무것도 없다 - 거기서 출발하면 선이 허공에서 시작한다. 갈래 첫 하위는
     * 언제나 부모와 같은 열(`place` 의 `c = col`)이라 이 열에는 카드가 반드시 있고,
     * 그 중 가장 아래 카드의 **바닥 경계**에서 출발하면 아래로는 같은 열에 카드가 없다.
     */
    const colTail = (node) => {
        const col = colAt.get(node.id);
        let best = at.get(node.id);
        const walk = (n) => {
            const b = at.get(n.id);
            if (colAt.get(n.id) === col && b.y + b.h > best.y + best.h) best = b;
            kidsOf(n).forEach(walk);
        };
        walk(node);
        return best;
    };

    /**
     * 갈래 블록 → 다음 형제 🔑 (**비합류** 갈래 뒤에 쓴다).
     * 합류가 말단들을 버스로 모아 화살촉 하나로 꽂는 것과 달리, 여기서는 **다음 형제로 잇는
     * 선 하나**뿐이다 - 갈래가 다시 모이지 않으므로 말단을 끌어오지 않는다.
     * 🔑 출발은 **같은 열의 가장 아래 카드 바닥**(`colTail`)이다. 다음 형제는
     * `bottomOf + gapY` 에 놓이고 출발 카드 아래로는 이 열에 카드가 없으므로,
     * 선은 카드에 붙어 시작하면서 어떤 카드도 지나지 않는다.
     */
    const blockNextEdge = (node, next) => {
        edges.push({ ...elbowPath(colTail(node), at.get(next.id)), fork: false });
    };

    /** 형제 사슬 - 아래로 잇는다. 합류 형제 뒤는 갈래 말단들을 모아 잇는다 */
    const chain = (list) => {
        list.slice(1).forEach((node, i) => {
            const prev = list[i];
            if (joins(prev)) {
                joinEdges(prev, node);
                return;
            }
            const from = spineTail(prev);
            if (!from) {
                blockNextEdge(prev, node);
                return;
            }
            edges.push({ ...elbowPath(at.get(from.id), at.get(node.id)), fork: false });
        });
    };

    const link = (node) => {
        const kids = kidsOf(node);
        if (kids.length) {
            if (node.fork || node.join) forkEdges(node, kids);
            else {
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
