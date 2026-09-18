/**
 * 업무프로세스 탭 가운데의 **흐름 도식** (간선 기반 DAG).
 *
 *   .pm-canvas (가로 스크롤)
 *     └ .pm-stage (position:relative · 크기는 계산 결과)
 *         ├ <svg class="pm-edges">  직교 꺾은선 + 화살촉 (pointer-events:none)
 *         ├ .pm-node (position:absolute)  ← 카드
 *         └ .pm-labels                    ← 선 위 라벨 칩 (HTML · 선과 좌표를 공유한다)
 *
 * 🔑 **흐름의 유일한 출처는 `db.processFlow`** 다 - 번호(`no`)·시작(`entries`)·끝(`exits`)·
 * 순환(`cyclic`)을 화면이 다시 계산하지 않는다. 좌표만 순수 함수(checkflow.js)가 낸다.
 *
 * 🔑 **카드는 기본으로 제목만**이다 (번호 배지 + 한 줄). 머리를 누르면 펼쳐져 설명·담당·
 * 상황 블록이 나온다. 흐름을 눈으로 훑는 것이 이 화면의 목적이라 접힌 상태가 기본이다.
 *
 * 🔑 상황(situation)은 간선에 들지 않는다 - 카드 안 주황 블록이고, 그 아래 대응 프로세스는
 * 트리(`sort_order`) 사슬이다. 「늘 있는 경로」와 「그날 생긴 일」은 층이 다르다.
 *
 * 🔑 **체크항목(kind=check)은 이 탭에 나오지 않는다.** 흐름과 그 설명만 다루고, 체크항목은
 * 일일체크리스트 탭이 맡는다 (데이터는 그대로 있고 탭1 이 읽는다 - docs/checklist.md).
 */
import { CHECK_KIND } from '../../config.js';
import { icon } from '../../icons.js';
import { esc } from '../../util.js';
import { DAG_SIZE, dagCols, laneWidth, layoutDag } from '../../checkflow.js';
import { openBtn, quickBar, stepCaption, whoHtml } from './common.js';

/** 트리에서 그 항목의 자식 (등록 순서 = sort_order) */
function kidsOf(rows, id) {
    return rows.filter((r) => r.parent_id === id)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

/** 상황 아래 대응 프로세스 한 줄 - 간선이 아니라 트리 사슬이라 번호는 `i+1` 이다 */
function chainVM(item, rows, no) {
    const kids = kidsOf(rows, item.id);
    const subs = kids.filter((c) => c.kind === CHECK_KIND.PROCESS);
    return {
        item,
        no,
        subs: subs.map((c, i) => chainVM(c, rows, i + 1)),
        situations: kids.filter((c) => c.kind === CHECK_KIND.SITUATION)
            .map((c) => sitVM(c, rows)),
    };
}

/** 상황 블록 - 대응 프로세스 사슬 */
function sitVM(item, rows) {
    return {
        item,
        subs: kidsOf(rows, item.id).filter((c) => c.kind === CHECK_KIND.PROCESS)
            .map((c, i) => chainVM(c, rows, i + 1)),
    };
}

/**
 * 업무항목 한 벌 → 화면 VM.
 * @param {object} group 업무항목 행
 * @param {Array} rows 그 업무항목 아래 항목 전부 (비활성 포함)
 * @param {object} flow db.processFlow 결과 - **번호·순서·상태는 전부 여기서 온다**
 * @returns {{item, flow, nodes:Array, edges:Array}}
 */
export function groupVM(group, rows, flow) {
    const nodes = flow.nodes.map((item) => ({
        item,
        no: flow.no[item.id] ?? null,
        situations: kidsOf(rows, item.id).filter((c) => c.kind === CHECK_KIND.SITUATION)
            .map((c) => sitVM(c, rows)),
    }));
    return {
        item: group,
        flow,
        nodes,
        // 좌표 계산이 쓰는 모양으로 바꾼다 (db 는 from_id·to_id, checkflow 는 from·to)
        edges: flow.edges.map((e) => ({
            id: e.id,
            from: e.from_id ?? null,
            to: e.to_id,
            label: e.label ?? '',
            sort_order: e.sort_order ?? 0,
        })),
    };
}

/* --------------------------------- 카드 조각 --------------------------------- */

/** 펼침 화살표 - 카드 머리를 누르면 상세가 열린다 */
function caretHtml(open) {
    return `<span class="pm-caret" aria-hidden="true">${icon(open ? 'down' : 'next', 'icon icon--sm')}</span>`;
}

/** 드래그 정렬 대상 속성 - 상황·대응 단계는 같은 상위 안에서 자리를 바꾼다 */
function dragAttr(item, parentId) {
    return `data-item="${esc(item.id)}" data-parent="${esc(parentId)}" data-kind="${esc(item.kind)}"`;
}

/** 편집 도구 - 드래그 손잡이 (편집 모드에서만 보인다) */
function gripHtml() {
    return `<span class="pm-tools"><span class="pm-grip" title="끌어서 순서 바꾸기"
        >${icon('menu', 'icon icon--sm')}</span></span>`;
}

/**
 * 순번 배지 🔑 - 카드 왼쪽의 사각 배지. 한 줄기는 `3`, 갈래 줄은 `4.1` 이라 폭이 늘어난다.
 * 번호는 `db.processFlow` 가 낸 것을 그대로 적는다 (화면이 다시 매기지 않는다).
 */
function noHtml(no) {
    if (no == null) return '';
    const txt = String(no);
    return `<span class="pm-no ${txt.includes('.') ? 'pm-no--fork' : ''}"
        ${txt.includes('.') ? 'title="갈래"' : ''}>${esc(txt)}</span>`;
}

/** 「처리 후 ③ 입고검수 로 이어집니다」 - 상황 블록 끝 문구 */
function mergeText(next) {
    return next
        ? `처리가 끝나면 <b>${stepCaption(next)}</b> 로 이어집니다`
        : '처리가 끝나면 흐름을 마칩니다';
}

/**
 * 상황 블록 - 카드 안의 주황 상자. 「X 발생 시」 → 대응 단계 → 처리 후 다음 단계.
 * @param {{title:string, no:number|string|null}|null} next 처리 후 돌아갈 단계 (흐름의 다음 단계)
 */
function sitHtml(s, parentId, next, state) {
    const it = s.item;
    const open = state.open.has(it.id);
    const detail = [
        it.description ? `<span>${esc(it.description)}</span>` : '',
        whoHtml(it),
        !s.subs.length ? '<span class="pm-note">대응 절차 없음 · 발생 내용만 기록</span>' : '',
        `<span class="pm-sit__merge">${icon('reply', 'icon icon--sm')}${mergeText(next)}</span>`,
    ].filter(Boolean).join('');
    return `
<div class="pm-sit ${it.active === false ? 'is-off' : ''} ${open ? 'is-open' : ''}" ${dragAttr(it, parentId)}>
  <div class="pm-sit__head" data-toggle="${esc(it.id)}" data-pick="${esc(it.id)}" data-sit="1">
    ${gripHtml()}
    ${icon('issues', 'icon icon--sm')}
    <strong>${esc(it.title)} 발생 시</strong>
    ${it.active === false ? '<span class="tag tag--gray">비활성</span>' : ''}
    <span class="toolbar__spacer"></span>
    ${openBtn(it, '상황')}
    ${caretHtml(open)}
  </div>
  ${open ? `
  <div class="pm-detail pm-detail--sit">${detail}</div>
  ${s.subs.length ? `<div class="pm-chain">${s.subs.map((p, i) => chainStep(p, {
        parentId: it.id, last: i === s.subs.length - 1, state,
    })).join('')}</div>` : ''}
  ${state.edit ? quickBar(it) : ''}` : ''}
</div>`;
}

/** 상황 블록 안의 대응 단계 - 카드보다 작은 줄 하나 (도식 노드가 아니다) */
function chainStep(p, o) {
    const it = p.item;
    const open = o.state.open.has(it.id);
    return `
<div class="pm-step pm-step--sub ${o.last ? 'is-last' : ''} ${it.active === false ? 'is-off' : ''}"
     ${dragAttr(it, o.parentId)}>
  <div class="pm-step__rail">${noHtml(p.no)}</div>
  <div class="pm-card">
    <div class="pm-card__head" data-toggle="${esc(it.id)}" data-pick="${esc(it.id)}">
      ${gripHtml()}
      <span class="pm-card__title">${esc(it.title)}</span>
      <span class="toolbar__spacer"></span>
      ${openBtn(it, '프로세스')}
      ${caretHtml(open)}
    </div>
    ${open ? `
    ${it.description || it.assignee_name ? `<div class="pm-detail"><span>${esc(it.description ?? '')}</span>${whoHtml(it)}</div>` : ''}
    ${p.subs.length ? `<div class="pm-chain">${p.subs.map((s, i) => chainStep(s, {
        parentId: it.id, last: i === p.subs.length - 1, state: o.state,
    })).join('')}</div>` : ''}
    ${p.situations.map((s) => sitHtml(s, it.id, null, o.state)).join('')}
    ${o.state.edit ? quickBar(it) : ''}` : ''}
  </div>
</div>`;
}

/**
 * 카드 아래 편집 손잡이 🔑 - **선 긋기**가 흐름 편집의 전부다.
 *   ＋  다음 단계를 새로 만들어 잇는다. 이미 다음 단계가 있으면 **한 번 더 눌러 갈래**를 만든다
 *   ↳  이미 있는 단계로 잇는다 (합류) - 연결 모드로 들어간다
 */
function portsHtml(id, adding) {
    if (adding) {
        return `
<form class="pm-port pm-port--form" data-next-form="${esc(id)}">
  <input type="text" name="title" maxlength="100" autocomplete="off"
         placeholder="다음 단계 이름 · Enter (Esc 닫기)">
  <button class="btn btn--sm btn--primary" type="submit">추가</button>
</form>`;
    }
    return `
<div class="pm-port">
  <button class="btn btn--sm btn--primary pm-port__btn" type="button" data-next="${esc(id)}"
          title="다음 단계 추가 (한 번 더 누르면 갈래)" aria-label="다음 단계 추가"
    >${icon('plus', 'icon icon--sm')}</button>
  <button class="btn btn--sm pm-port__btn" type="button" data-link="${esc(id)}"
          title="이미 있는 단계로 잇기 (합류)" aria-label="이미 있는 단계로 잇기"
    >${icon('branch', 'icon icon--sm')}</button>
</div>`;
}

/**
 * 도식 노드 한 개 - 프로세스 카드. 접히면 **번호 + 제목 한 줄**이다.
 * @param {{next:object|null, state:object, picked:boolean, exit:boolean, block:boolean}} o
 */
function nodeHtml(p, o) {
    const it = p.item;
    const { state } = o;
    const open = state.open.has(it.id);
    const detail = [
        it.description ? `<span>${esc(it.description)}</span>` : '',
        whoHtml(it),
    ].filter(Boolean).join('');
    const linking = !!state.link;
    return `
<div class="pm-node ${it.active === false ? 'is-off' : ''} ${open ? 'is-open' : ''}
     ${o.picked ? 'is-picked' : ''} ${o.block ? 'is-nolink' : ''}"
     data-node="${esc(it.id)}">
  <div class="pm-card">
    <div class="pm-card__head" ${linking ? `data-target="${esc(it.id)}"` : `data-toggle="${esc(it.id)}" data-pick="${esc(it.id)}"`}>
      ${noHtml(p.no)}
      <span class="pm-card__title">${esc(it.title)}</span>
      ${it.active === false ? '<span class="tag tag--gray">비활성</span>' : ''}
      ${o.exit ? '<span class="tag tag--amber pm-tip">이후 단계 없음</span>' : ''}
      <span class="toolbar__spacer"></span>
      ${openBtn(it, '프로세스')}
      ${caretHtml(open)}
    </div>
    ${open ? `
    ${detail ? `<div class="pm-detail">${detail}</div>` : ''}
    ${p.situations.map((s) => sitHtml(s, it.id, o.next, state)).join('')}
    ${state.edit ? quickBar(it) : ''}` : ''}
  </div>
  ${state.edit && !linking ? portsHtml(it.id, state.step?.fromId === it.id) : ''}
</div>`;
}

/** 흐름 상태 알림 - 시작이 여럿 · 순환 (막지는 않고 알린다) */
function statusHtml(flow) {
    const out = [];
    if (flow.cyclic) {
        out.push(`<span class="tag tag--red">${icon('issues', 'icon icon--sm')} 흐름이 되돌아옵니다 (순환) · 연결을 하나 끊으세요</span>`);
    }
    if (flow.entries.length > 1) {
        out.push(`<span class="tag tag--gray">시작 단계 ${flow.entries.length}개</span>`);
    }
    return out.length ? `<div class="pm-status">${out.join('')}</div>` : '';
}

/**
 * 가운데 도식 마크업. 자리는 아직 없다 - 붙인 뒤 layoutCanvas() 가 잡는다.
 * @param {object} gvm groupVM 결과
 * @param {object} state 화면 상태 (edit · open · pick · link · step)
 */
export function canvasHtml(gvm, state) {
    if (!gvm.nodes.length) {
        return `
<div class="pm-canvas">
  <p class="pm-empty">아직 단계가 없습니다.
    ${state.edit ? '아래 「+ 다음 프로세스」 로 첫 단계를 넣으세요.' : '「편집」 을 켜고 첫 단계를 넣으세요.'}</p>
</div>`;
    }
    const { flow } = gvm;
    // 끝이 여럿이면 각 카드에 알린다 (하나뿐이면 그게 흐름의 끝이라 당연하다)
    const exits = new Set(flow.exits.length > 1 ? flow.exits : []);
    const block = state.link?.block ?? null;
    return `
${statusHtml(flow)}
<div class="pm-canvas">
  <div class="pm-stage is-measuring">
    <svg class="pm-edges" width="0" height="0" aria-hidden="true"></svg>
    ${gvm.nodes.map((p) => nodeHtml(p, {
        state,
        next: nextCaption(gvm, p.item.id),
        picked: state.pick === p.item.id,
        exit: exits.has(p.item.id),
        block: !!block?.has(p.item.id),
    })).join('')}
    <div class="pm-labels"></div>
  </div>
</div>`;
}

/** 그 단계의 다음 단계 캡션 (상황 블록의 「처리 후 …」 용) - 갈래면 첫 갈래를 적는다 */
function nextCaption(gvm, id) {
    const to = (gvm.flow.nexts[id] ?? [])[0];
    if (!to) return null;
    const node = gvm.nodes.find((n) => n.item.id === to);
    return node ? { title: node.item.title, no: node.no } : null;
}

/**
 * 2-pass 배치 🔑 - 레인 폭을 정해 내려주고 → 카드 높이를 재고 → 좌표를 잡고 선을 그린다.
 *
 * 🔑 **순서가 중요하다.** 열 수(`dagCols`)는 측정값 없이 셀 수 있으므로 **재기 전에** 레인
 * 폭을 정해 `--pm-lane` 으로 내려 준다. 순서를 어기면 카드가 다른 폭으로 줄바꿈된 높이를
 * 쓰게 되어 선이 카드에서 떨어진다 (지난 결함).
 *
 * 라벨 칩은 SVG 가 아니라 **HTML** 이다 - 같은 좌표계(.pm-stage)에 얹어 클릭·팝오버를 붙인다.
 * @param {HTMLElement} host 도식이 들어 있는 엘리먼트 (.pm-canvas 를 품는다)
 * @param {object} gvm groupVM 결과
 * @param {{width?:number, edit?:boolean}} o width - 가용폭 직접 지정 (인쇄는 A4 폭)
 */
export function layoutCanvas(host, gvm, o = {}) {
    const stage = host.querySelector('.pm-stage');
    if (!stage) return;
    const nodes = gvm.nodes.map((p) => ({ id: p.item.id, height: 0 }));
    // 편집 모드에서는 라벨이 없는 간선도 작은 점으로 집을 수 있어야 한다
    const edges = gvm.edges.map((e) => ({ ...e, label: e.label || (o.edit ? '·' : '') }));
    const avail = o.width ?? host.querySelector('.pm-canvas')?.clientWidth ?? 0;
    const lane = laneWidth(avail, dagCols(nodes, edges), { gapX: DAG_SIZE.gapX });
    stage.style.setProperty('--pm-lane', `${lane}px`);

    nodes.forEach((n) => {
        const el = stage.querySelector(`.pm-node[data-node="${CSS.escape(n.id)}"]`);
        n.height = el ? el.offsetHeight : 0;
    });
    const out = layoutDag(nodes, edges, { lane });

    Object.entries(out.boxes).forEach(([id, b]) => {
        const el = stage.querySelector(`.pm-node[data-node="${CSS.escape(id)}"]`);
        if (!el) return;
        el.style.left = `${b.x}px`;
        el.style.top = `${b.y}px`;
    });
    stage.style.width = `${out.width}px`;
    stage.style.height = `${out.height}px`;
    const svg = stage.querySelector('.pm-edges');
    svg.setAttribute('width', out.width);
    svg.setAttribute('height', out.height);
    // ⚠️ 합류 버스는 좌표가 겹쳐 그려진다 - 반투명을 쓰면 겹친 자리만 진해진다 (불투명만)
    svg.innerHTML = out.edges.map((e) => `
<path class="pm-edge" d="${e.path}" />
<path class="pm-edge__head" d="${e.head}" />`).join('');

    const labels = stage.querySelector('.pm-labels');
    const raw = new Map(gvm.edges.map((e) => [e.id, e]));
    // 🔑 칩의 자리·크기는 layoutDag 가 정한다 (겹침을 좌표 계산에서 막는다 - P13)
    labels.innerHTML = out.edges.filter((e) => e.label).map((e) => {
        const dot = !raw.get(e.id)?.label;
        const style = `left:${e.label.x}px; top:${e.label.y}px; `
            + `width:${e.label.w}px; height:${e.label.h}px`;
        if (!o.edit) {
            return `<span class="pm-elabel" style="${style}">${esc(e.label.text)}</span>`;
        }
        return `<button class="pm-elabel ${dot ? 'is-dot' : ''}" type="button"
            data-edge="${esc(e.id)}" style="${style}"
            title="${esc(e.label.text)} · 조건 라벨 · 갈래 순서 · 연결 끊기"
            >${esc(e.label.text)}</button>`;
    }).join('');
    stage.classList.remove('is-measuring');
}
