/**
 * 업무프로세스 탭 가운데의 **흐름 도식**.
 *
 * 노드는 지금까지 쓰던 HTML 카드 그대로다 (드래그 손잡이 · 접힘/펼침 · ✎ 속성 모달이 살아 있다).
 * 달라진 것은 **잇는 선만 SVG** 이고 카드가 좌표로 놓인다는 점이다.
 *
 *   .pm-canvas (가로 스크롤)
 *     └ .pm-stage (position:relative · 크기는 계산 결과)
 *         ├ <svg class="pm-edges">  직교 꺾은선 + 화살촉 (pointer-events:none)
 *         └ .pm-node (position:absolute)  ← 카드
 *
 * 좌표 계산은 순수 함수(assets/js/checkflow.js)가 한다. 카드 높이는 접힘·체크항목 수에 따라
 * 달라지므로 **먼저 붙여서 재고**(1-pass) 그 값으로 자리를 잡는다(2-pass).
 *
 * 🔑 하위 프로세스는 카드 안이 아니라 **아래에 놓인 다른 노드**로 나온다 - 순차 하위는 같은
 * 열에서 들여쓰고, 갈래는 오른쪽으로 벌린다 (읽는 규칙: 아래로 = 다음 단계).
 * 상황(주황 블록)은 예외 처리라 지금처럼 카드 안에 그대로 둔다.
 *
 * 🔑 **합류(join)** 는 갈래를 벌린 뒤 **자기 다음 형제**로 다시 모으는 것이다. 모일 곳은
 * 고르지 않고 언제나 다음 형제라, 여기서는 그 형제를 `joinTo` 로 달아 두기만 한다.
 */
import { CHECK_KIND, cycleLabel, isFork, isJoin } from '../../config.js';
import { icon } from '../../icons.js';
import { esc } from '../../util.js';
import { flowCols, forkBase, laneWidth, layoutFlow, rowNos } from '../../checkflow.js';
import { openBtn, quickBar, stepCaption, whoHtml } from './common.js';

/** 도식 노드가 되는 하위인가 (체크항목·상황은 카드 안에 들어간다) */
function isStep(node) {
    return node.item.kind !== CHECK_KIND.CHECK && node.item.kind !== CHECK_KIND.SITUATION;
}

/**
 * 하위 프로세스 줄의 번호 🔑 - 채번은 `checkflow.rowNos` 한 곳이다.
 * 갈래 줄이면 `4.1` `4.2`, 순차 줄이면 `①②③` 이고 갈래 부모는 슬롯을 2칸 쓴다.
 * @param {Array} kids 트리 자식 전부 (프로세스만 골라 쓴다)
 * @param {boolean} fork 이 줄이 갈래 줄인가
 * @param {number|string|null} no 부모 번호 (갈래 줄의 앞자리를 여기서 만든다)
 */
function stepNos(kids, fork, no) {
    return rowNos(kids.filter(isStep), {
        fork,
        base: forkBase(no),
        isBranch: (c) => isFork(c.item) && c.children.some(isStep),
    });
}

/**
 * 트리 노드 → 화면 VM. 프로세스 모양 { item, no, rows(체크항목), subs(하위 프로세스), situations }
 * 순번(no)은 같은 줄 안의 슬롯이다 - 순차면 정수, **갈래 줄이면 `4.1` 꼴 점 번호**다.
 * @param {boolean} branch 갈래 줄에 놓인 노드인가 (번호 뱃지를 파란 알약으로 그린다)
 */
function treeToVM(node, no, branch = false) {
    const vm = {
        item: node.item, no, branch, rows: [], subs: [], situations: [],
        fork: isFork(node.item), join: isJoin(node.item),
    };
    const nos = stepNos(node.children, vm.fork, no);
    let at = 0;
    node.children.forEach((c) => {
        if (c.item.kind === CHECK_KIND.CHECK) vm.rows.push(c.item);
        else if (c.item.kind === CHECK_KIND.SITUATION) vm.situations.push(treeToSitVM(c));
        else {
            vm.subs.push(treeToVM(c, nos[at], vm.fork));
            at += 1;
        }
    });
    markJoins(vm.subs, !vm.fork);
    return vm;
}

/**
 * 합류(join) 하위에 **모일 곳**(다음 형제)을 달아 준다.
 * @param {boolean} chained 형제끼리 이어지는 줄인가. 갈래로 벌린 줄은 이어지지 않아 모일 곳이 없다
 *   (그때는 갈래와 똑같이 그리고 카드 상세에 주의 문구를 띄운다)
 */
function markJoins(subs, chained) {
    subs.forEach((s, i) => {
        s.joinTo = chained && s.join && s.subs.length ? (subs[i + 1] ?? null) : null;
        s.joinRow = chained;
    });
}

function treeToSitVM(node) {
    const vm = { item: node.item, rows: [], subs: [], fork: isFork(node.item) };
    // 상황에는 번호가 없다 - 대응 단계는 ①②③ 부터, 갈래면 `1.1` `1.2` 다
    const nos = stepNos(node.children, vm.fork, null);
    let at = 0;
    node.children.forEach((c) => {
        if (c.item.kind === CHECK_KIND.CHECK) vm.rows.push(c.item);
        else if (c.item.kind === CHECK_KIND.PROCESS) {
            vm.subs.push(treeToVM(c, nos[at], vm.fork));
            at += 1;
        }
    });
    markJoins(vm.subs, !vm.fork);
    return vm;
}

/** 업무항목 노드 한 그루 → { item, processes, loose, fork } */
export function groupVM(tree) {
    const processes = [];
    const loose = [];
    const fork = isFork(tree.item);
    const nos = stepNos(tree.children, fork, null);
    let at = 0;
    tree.children.forEach((c) => {
        if (c.item.kind === CHECK_KIND.CHECK) loose.push(c.item);
        else if (c.item.kind === CHECK_KIND.PROCESS) {
            processes.push(treeToVM(c, nos[at], fork));
            at += 1;
        }
    });
    markJoins(processes, !fork);
    return { item: tree.item, processes, loose, fork };
}

/* --------------------------------- 카드 조각 --------------------------------- */

/** 편집 도구 - 드래그 손잡이 (편집 모드에서만 보인다) */
function gripHtml() {
    return `<span class="pm-tools"><span class="pm-grip" title="끌어서 순서 바꾸기"
        >${icon('menu', 'icon icon--sm')}</span></span>`;
}

/** 펼침 화살표 - 카드 머리를 누르면 상세가 열린다 */
function caretHtml(open) {
    return `<span class="pm-caret" aria-hidden="true">${icon(open ? 'down' : 'next', 'icon icon--sm')}</span>`;
}

/** 드래그 정렬 대상 속성 - 같은 상위·같은 종류끼리만 자리를 바꾼다 */
function dragAttr(item, parentId) {
    return `data-item="${esc(item.id)}" data-parent="${esc(parentId)}" data-kind="${esc(item.kind)}"`;
}

/** 일일체크리스트 포함 토글 - 켠 항목만 일일체크리스트에 나온다 */
function dailyToggle(item) {
    return `
<label class="cl-daily ${item.daily ? 'is-on' : ''}" title="일일체크리스트에 포함">
  <input type="checkbox" data-daily="${esc(item.id)}" ${item.daily ? 'checked' : ''}>
  <span>일일</span>
</label>`;
}

/**
 * 순번 뱃지 🔑 - 한 줄기의 정수는 파란 동글, **갈래 줄의 점 번호(`4.1`)는 파란 알약**이다.
 * 갈래인지는 `no` 가 비었는지가 아니라 `branch` 플래그로 가른다 (갈래 하위도 번호를 가진다).
 */
function noHtml(no, branch) {
    if (no == null) return '';
    return `<span class="pm-no ${branch ? 'pm-no--fork' : ''}"
        ${branch ? 'title="갈래"' : ''}>${esc(String(no))}</span>`;
}

/** 체크항목 한 줄. 접힌 카드에서는 이름만, 펼치면(open) 설명·주기·담당·일일 제외가 붙는다 */
function checkRow(r, parentId, open) {
    const subs = r.sub_assignees ?? [];
    const who = `${r.assignee_name ? ` · ${esc(r.assignee_name)}` : ''}${subs.length
        ? ` · 부 ${esc(subs.map((s) => s.name).join(', '))}` : ''}`;
    return `
<div class="pm-check ${r.active === false ? 'is-off' : ''} ${r.daily ? '' : 'is-skip'}" ${dragAttr(r, parentId)}>
  ${gripHtml()}
  ${icon('square', 'icon icon--sm pm-check__box')}
  <span class="pm-check__title">${esc(r.title)}
    ${open && r.description ? `<small>${esc(r.description)}</small>` : ''}</span>
  ${open ? `<span class="pm-check__meta">${esc(cycleLabel(r))}${who}</span>` : ''}
  ${open && !r.daily ? '<span class="tag tag--gray pm-skip">일일 제외</span>' : ''}
  ${r.active === false ? '<span class="tag tag--gray">비활성</span>' : ''}
  <span class="pm-tools">${dailyToggle(r)}</span>
  ${openBtn(r, '체크항목')}
</div>`;
}

/** 「처리 후 ③ 입고검수 로 이어집니다」 - 상황 블록 끝 문구 */
function mergeText(next) {
    return next
        ? `처리가 끝나면 <b>${stepCaption({ title: next.item.title, no: next.no })}</b> 로 이어집니다`
        : '처리가 끝나면 흐름을 마칩니다';
}

/**
 * 상황 블록 - 카드 안의 주황 상자. 「X 발생 시」 → 대응 체크항목·대응 단계 → 처리 후 다음 단계.
 * 상황 아래 대응 프로세스는 예외 절차라 지금처럼 블록 안 작은 사슬로 그린다.
 */
function sitHtml(s, parentId, next, state) {
    const it = s.item;
    const open = state.open.has(it.id);
    const detail = [
        it.description ? `<span>${esc(it.description)}</span>` : '',
        whoHtml(it),
        !s.rows.length && !s.subs.length ? '<span class="pm-note">대응 절차 없음 · 발생 내용만 기록</span>' : '',
        `<span class="pm-sit__merge">${icon('reply', 'icon icon--sm')}${mergeText(next)}</span>`,
    ].filter(Boolean).join('');
    return `
<div class="pm-sit ${it.active === false ? 'is-off' : ''} ${open ? 'is-open' : ''}" ${dragAttr(it, parentId)}>
  <div class="pm-sit__head" data-toggle="${esc(it.id)}">
    ${gripHtml()}
    ${icon('issues', 'icon icon--sm')}
    <strong>${esc(it.title)} 발생 시</strong>
    ${it.active === false ? '<span class="tag tag--gray">비활성</span>' : ''}
    <span class="toolbar__spacer"></span>
    ${openBtn(it, '상황')}
    ${caretHtml(open)}
  </div>
  ${open ? `<div class="pm-detail pm-detail--sit">${detail}</div>` : ''}
  ${s.rows.length ? `<div class="pm-checks">${s.rows.map((r) => checkRow(r, it.id, open)).join('')}</div>` : ''}
  ${s.subs.length ? `<div class="pm-chain">${s.subs.map((p, i) => chainStep(p, {
        parentId: it.id, last: i === s.subs.length - 1, state,
    })).join('')}</div>` : ''}
  ${state.edit ? quickBar(it) : ''}
</div>`;
}

/** 상황 블록 안의 대응 단계 - 카드보다 작은 줄 하나 (도식 노드가 아니다) */
function chainStep(p, o) {
    const it = p.item;
    const open = o.state.open.has(it.id);
    return `
<div class="pm-step pm-step--sub ${o.last ? 'is-last' : ''} ${it.active === false ? 'is-off' : ''}"
     ${dragAttr(it, o.parentId)}>
  <div class="pm-step__rail">${noHtml(p.no, p.branch)}</div>
  <div class="pm-card">
    <div class="pm-card__head" data-toggle="${esc(it.id)}">
      ${gripHtml()}
      <span class="pm-card__title">${esc(it.title)}</span>
      ${!p.rows.length && !p.subs.length ? `<span class="pm-tools">${dailyToggle(it)}</span>` : ''}
      <span class="toolbar__spacer"></span>
      ${openBtn(it, '프로세스')}
      ${caretHtml(open)}
    </div>
    ${open && it.description ? `<div class="pm-detail"><span>${esc(it.description)}</span>${whoHtml(it)}</div>` : ''}
    ${p.rows.length ? `<div class="pm-checks">${p.rows.map((r) => checkRow(r, it.id, open)).join('')}</div>` : ''}
    ${p.subs.length ? `<div class="pm-chain">${p.subs.map((s, i) => chainStep(s, {
        parentId: it.id, last: i === p.subs.length - 1, state: o.state,
    })).join('')}</div>` : ''}
    ${p.situations.map((s) => sitHtml(s, it.id, null, o.state)).join('')}
    ${o.state.edit ? quickBar(it) : ''}
  </div>
</div>`;
}

/**
 * 「갈래가 다시 ③ 출고완료 로 모입니다」 - 합류(join) 단계의 카드 상세 한 줄.
 * 갈래로 벌린 줄(`joinRow` 가 false)은 형제끼리 이어지지 않아 모일 곳이 원래 없다.
 * 그때까지 경고로 적으면 다음 형제가 눈에 보이는 탓에 오해를 부르므로 설명으로 적는다.
 */
function joinNote(p) {
    if (p.joinTo) {
        return `<span class="pm-note pm-note--join">${icon('reply', 'icon icon--sm')}갈래가 다시
        <b>${stepCaption({ title: p.joinTo.item.title, no: p.joinTo.no })}</b> 로 모입니다</span>`;
    }
    if (!p.joinRow) return '<span class="pm-note">갈래 안이라 여기서는 모이지 않습니다</span>';
    return '<span class="pm-note pm-note--warn">합류할 다음 단계가 없습니다</span>';
}

/**
 * 도식 노드 한 개 - 프로세스 카드.
 * @param {{parentId:string, next:object|null, state:object, picked:boolean}} o
 */
function nodeHtml(p, o) {
    const it = p.item;
    const leaf = !p.rows.length && !p.subs.length;
    const open = o.state.open.has(it.id);
    // 🔑 담당은 **직접 지정한 노드**에만 붙는다(비우면 상위를 따르므로 whoHtml 이 빈 값).
    // 그래서 접힌 카드에 그대로 내보내면 **담당이 바뀌는 지점에만** 칩이 생기고,
    // 칩이 없는 카드는 「위 담당이 이어진다」로 읽힌다 - 스윔레인이 하는 일과 같은 정보다.
    const who = whoHtml(it);
    const detail = [
        it.description ? `<span>${esc(it.description)}</span>` : '',
        leaf ? '<span class="pm-note">체크항목 없음 · 단계 자체를 체크</span>' : '',
        leaf && !it.daily ? '<span class="tag tag--gray pm-skip">일일 제외</span>' : '',
        p.subs.length && p.fork ? '<span class="pm-note">하위는 갈래입니다 (조건에 따라 하나를 탑니다)</span>' : '',
        p.subs.length && p.join ? joinNote(p) : '',
    ].filter(Boolean).join('');
    return `
<div class="pm-node ${it.active === false ? 'is-off' : ''} ${open ? 'is-open' : ''} ${o.picked ? 'is-picked' : ''}"
     data-node="${esc(it.id)}" ${dragAttr(it, o.parentId)}>
  <div class="pm-card">
    <div class="pm-card__head" data-toggle="${esc(it.id)}" data-pick="${esc(it.id)}">
      ${gripHtml()}
      ${noHtml(p.no, p.branch)}
      <span class="pm-card__title">${esc(it.title)}</span>
      ${who}
      ${it.active === false ? '<span class="tag tag--gray">비활성</span>' : ''}
      ${leaf ? `<span class="pm-tools">${dailyToggle(it)}</span>` : ''}
      <span class="toolbar__spacer"></span>
      ${openBtn(it, '프로세스')}
      ${caretHtml(open)}
    </div>
    ${open && detail ? `<div class="pm-detail">${detail}</div>` : ''}
    ${p.rows.length ? `<div class="pm-checks">${p.rows.map((r) => checkRow(r, it.id, open)).join('')}</div>` : ''}
    ${p.situations.map((s) => sitHtml(s, it.id, o.next, o.state)).join('')}
    ${o.state.edit ? quickBar(it) : ''}
  </div>
</div>`;
}

/** 프로세스 VM 을 도식 순서(부모 → 자식)대로 편다 */
function flatten(processes, parentId, next, out) {
    processes.forEach((p, i) => {
        const after = processes[i + 1] ?? next;
        out.push({ p, parentId, next: after });
        flatten(p.subs, p.item.id, after, out);
    });
    return out;
}

/**
 * 가운데 도식 마크업. 자리는 아직 없다 - 붙인 뒤 layoutCanvas() 가 잡는다.
 * @param {object} gvm groupVM 결과
 * @param {object} state 화면 상태 (edit · open · pick)
 */
export function canvasHtml(gvm, state) {
    if (!gvm.processes.length) {
        return `<div class="pm-canvas"><p class="pm-empty">아직 프로세스가 없습니다.${state.edit
            ? ' 아래 「+ 다음 프로세스」 로 첫 단계를 넣으세요.'
            : ' 「편집」을 켜고 첫 프로세스 이름을 입력하세요.'}</p></div>`;
    }
    const nodes = flatten(gvm.processes, gvm.item.id, null, []);
    return `
<div class="pm-canvas">
  <div class="pm-stage is-measuring">
    <svg class="pm-edges" width="0" height="0" aria-hidden="true"></svg>
    ${nodes.map(({ p, parentId, next }) => nodeHtml(p, {
        parentId, next, state, picked: state.pick === p.item.id,
    })).join('')}
  </div>
</div>`;
}

/** 단독 업무 - 흐름에 속하지 않아 도식 아래에 따로 둔다 */
export function looseHtml(gvm, state) {
    if (!gvm.loose.length) return '';
    const open = state.open.has(gvm.item.id);
    return `
<div class="pm-loose ${open ? 'is-open' : ''}">
  <div class="pm-card">
    <div class="pm-card__head" data-toggle="${esc(gvm.item.id)}">
      ${icon('square', 'icon icon--sm')}
      <span class="pm-card__title">단독 업무</span>
      <span class="pm-card__desc">흐름과 상관없이 그때그때 하는 일</span>
      <span class="toolbar__spacer"></span>
      ${caretHtml(open)}
    </div>
    <div class="pm-checks">${gvm.loose.map((r) => checkRow(r, gvm.item.id, open)).join('')}</div>
  </div>
</div>`;
}

/**
 * 2-pass 배치 🔑 - 레인 폭을 정해 내려주고 → 카드 높이를 재고 → 좌표를 잡고 선을 그린다.
 *
 * 🔑 **순서가 중요하다.** 열 수(`flowCols`)는 측정값 없이 셀 수 있으므로 **재기 전에** 레인
 * 폭을 정해 `--pm-lane` 으로 내려 준다. 순서를 어기면 카드가 다른 폭으로 줄바꿈된 높이를
 * 쓰게 되어 선이 카드에서 떨어진다.
 * @param {HTMLElement} host 도식이 들어 있는 엘리먼트 (.pm-canvas 를 품는다)
 * @param {object} gvm groupVM 결과
 * @param {{width?:number}} [o] width - 가용폭을 직접 줄 때 (인쇄는 A4 폭을 넣는다)
 */
export function layoutCanvas(host, gvm, o = {}) {
    const stage = host.querySelector('.pm-stage');
    if (!stage) return;
    const toNode = (p) => ({
        id: p.item.id,
        height: 0,
        fork: !!p.fork,
        join: !!p.join,
        children: p.subs.map(toNode),
    });
    const roots = gvm.processes.map(toNode);
    const avail = o.width ?? host.querySelector('.pm-canvas')?.clientWidth ?? 0;
    const lane = laneWidth(avail, flowCols(roots, gvm.fork));
    stage.style.setProperty('--pm-lane', `${lane}px`);

    const measured = new Map();
    stage.querySelectorAll('.pm-node').forEach((el) => {
        measured.set(el.dataset.node, el.offsetHeight);
    });
    const fill = (n) => {
        n.height = measured.get(n.id) ?? 0;
        n.children.forEach(fill);
    };
    roots.forEach(fill);
    const { boxes, edges, width, height } = layoutFlow(roots, { rootFork: gvm.fork, lane });

    boxes.forEach((b) => {
        const el = stage.querySelector(`.pm-node[data-node="${CSS.escape(b.id)}"]`);
        if (!el) return;
        el.style.left = `${b.x}px`;
        el.style.top = `${b.y}px`;
        // 순차 하위는 들여쓰기 + 왼쪽 레일로 「같은 줄기의 하위」임을 알린다
        el.classList.toggle('is-indent', b.indent > 0);
    });
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    const svg = stage.querySelector('.pm-edges');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.innerHTML = edges.map((e) => `
<path class="pm-edge ${e.fork ? 'is-fork' : ''} ${e.join ? 'is-join' : ''}" d="${e.d}" />
${e.head ? `<path class="pm-edge__head ${e.join ? 'is-join' : ''}" d="${e.head}" />` : ''}`).join('');
    stage.classList.remove('is-measuring');
}
