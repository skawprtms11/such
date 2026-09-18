/**
 * 업무프로세스 탭 - 세 칸 화면.
 *
 *   좌 pm-nav     업무구분 › 업무항목 (등록·선택)
 *   중 pm-canvas  흐름 도식 (flowview.js · 제목만 보이는 카드 + SVG 선)
 *   우 pm-side    고른 단계의 **설명 표** (구분 · 내용 · 비고)
 *
 * 🔑 **이 탭이 다루는 것은 흐름과 그 설명뿐이다.** 체크항목(kind=check)은 만들지도 보이지도
 * 않는다 - 일일체크리스트 탭이 맡는다 (docs/checklist.md).
 *
 * 🔑 **흐름 편집은 「선 긋기」다.** 속성 폼에서 연결 방식을 고르는 것이 아니라
 * 카드 아래 ＋(다음 단계) · ↳(이미 있는 단계로 잇기)로 간선을 만들고, 선 위 라벨 칩에서
 * 조건·갈래 순서·연결 끊기를 한다. 규칙(순환 금지·브릿지)은 전부 db.js 가 판단한다.
 *
 * 좁은 화면에서는 우측을 먼저 접고(서랍), 더 좁으면 세그먼트로 한 칸씩 본다 (app.css).
 */
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import { CHECK_KIND, CHECK_TEMPLATES } from '../../config.js';
import { esc, num, toast, confirmDialog } from '../../util.js';
import {
    UNSORTED_ID, circled, iconBtn, openBtn, quickBar, segHtml, textBtn, whoHtml,
} from './common.js';
import { canvasHtml, groupVM, layoutCanvas } from './flowview.js';
import { openForm } from './form.js';

/** 인쇄용 가용폭 (px) - A4 세로에서 여백을 뺀 대략치 */
const PRINT_W = 680;

/** 지금 그려져 있는 도식 - 창 리사이즈·인쇄가 카드를 다시 그리지 않고 좌표만 다시 잡는다 */
let shown = null;

/** 열려 있는 간선 팝오버를 닫는 함수 (문서 리스너를 함께 걷는다) */
let closePop = null;

/** 연결 모드의 Esc 리스너를 걷는 함수 */
let offEsc = null;

/** 화면을 떠날 때 창 리사이즈·문서 리스너를 모두 끊는다 (checklist.js 의 정리 함수가 부른다) */
export function disposeManage() {
    shown?.off();
    shown = null;
    closePop?.();
    offEsc?.();
    offEsc = null;
}

/**
 * 도식 재배치 구독 🔑 - 창 리사이즈는 **디바운스로 한 번만** 한다.
 * 서랍 여닫기·세그먼트 전환은 화면을 통째로 다시 그리므로 여기서 따로 걸지 않는다.
 */
function watchCanvas(body, gvm, edit) {
    shown?.off();
    shown = null;
    if (!gvm) return;
    let timer = null;
    const onResize = () => {
        clearTimeout(timer);
        timer = setTimeout(() => layoutCanvas(body, gvm, { edit }), 150);
    };
    window.addEventListener('resize', onResize);
    shown = {
        body,
        gvm,
        edit,
        off: () => {
            clearTimeout(timer);
            window.removeEventListener('resize', onResize);
        },
    };
}

export async function drawManage(ctx) {
    const { state, body, user, users, reload } = ctx;
    closePop?.();
    offEsc?.();
    offEsc = null;
    const divisions = await db.listChecklistDivisions();
    // 업무구분 없는 옛 업무항목이 있으면 「미분류」 를 마지막에 붙인다 (옮길 수 있게)
    const orphans = await db.listChecklistGroups(null);
    const navDivs = [
        ...divisions,
        ...(orphans.length
            ? [{ id: UNSORTED_ID, title: '미분류', kind: CHECK_KIND.DIVISION, active: true }]
            : []),
    ];
    const groupsBy = {};
    for (const d of navDivs) {
        groupsBy[d.id] = d.id === UNSORTED_ID ? orphans : await db.listChecklistGroups(d.id);
    }
    if (!navDivs.some((d) => d.id === state.division)) state.division = navDivs[0]?.id ?? null;
    const division = navDivs.find((d) => d.id === state.division) ?? null;
    const isUnsorted = division?.id === UNSORTED_ID;
    const groups = division ? groupsBy[division.id] : [];
    if (!groups.some((g) => g.id === state.group)) state.group = groups[0]?.id ?? null;
    const group = groups.find((g) => g.id === state.group) ?? null;
    const rows = group
        ? await db.listChecklistItems({ root: group.id, includeInactive: true })
        : [];
    // 흐름(번호·시작·끝·순환)은 db 가 낸 것을 그대로 읽는다 - 화면이 다시 계산하지 않는다
    const flow = group ? await db.processFlow(group.id, { includeInactive: true }) : null;
    const gvm = group ? groupVM(group, rows, flow) : null;
    const templates = (division && !isUnsorted ? Object.keys(CHECK_TEMPLATES) : [])
        .filter((name) => !groups.some((g) => g.title === name));
    const allGroups = Object.values(groupsBy).flat();
    const findItem = (id) => rows.find((r) => r.id === id)
        ?? allGroups.find((g) => g.id === id)
        ?? divisions.find((d) => d.id === id);

    if (state.link) await prepLink(state, flow, group);
    if (state.step && !flow?.order.includes(state.step.fromId)) state.step = null;

    body.className = `card__body cl-manage ${state.edit ? 'is-edit' : ''} ${state.link ? 'is-linking' : ''}`;
    body.innerHTML = `
<div class="pm ${state.side ? 'is-side-open' : ''}" data-pane="${esc(state.pane)}"
     ${state.sideW ? `style="--pm-side-w:${Number(state.sideW)}px"` : ''}>
  <aside class="pm-nav">
    <div class="pm-nav__head">
      <span>업무구분 › 업무항목</span>
      <span class="toolbar__spacer"></span>
      <span class="pm-tools">${textBtn('plus', '업무구분', 'id="btn-add-division"', 'btn btn--sm btn--primary')}</span>
    </div>
    ${navDivs.map((d) => `
    <div class="pm-nav__div ${d.id === state.division ? 'is-active' : ''} ${d.active ? '' : 'is-off'}">
      <button class="pm-nav__divbtn" type="button" data-nav-div="${esc(d.id)}">
        ${icon('checklist', 'icon icon--sm')}<span>${esc(d.title)}</span>
        <small>${num(groupsBy[d.id].length)}</small></button>
      ${d.id === UNSORTED_ID ? '' : openBtn(d, '업무구분')}
    </div>
    <div class="pm-nav__grps">
      ${groupsBy[d.id].map((g) => `
      <button class="pm-nav__grp ${g.id === state.group ? 'is-active' : ''} ${g.active ? '' : 'is-off'}"
              type="button" data-nav-grp="${esc(g.id)}" data-nav-in="${esc(d.id)}">${esc(g.title)}</button>`).join('')}
      ${d.id === UNSORTED_ID ? '' : `<span class="pm-tools">${textBtn('plus', '업무항목',
        `data-add="${esc(d.id)}" data-kind="${CHECK_KIND.GROUP}"`, 'btn btn--sm pm-add pm-nav__add')}</span>`}
    </div>`).join('')}
    ${navDivs.length ? '' : '<p class="pm-nav__empty">업무구분이 없습니다.<br>「업무구분」 을 눌러 시작하세요.</p>'}
  </aside>
  <section class="pm-main">
    <header class="pm-head">
      ${group ? `
      <span class="pm-head__crumb">${esc(division.title)} ›</span>
      <strong class="pm-head__title">${esc(group.title)}</strong>
      ${group.description ? `<span class="pm-head__desc">${esc(group.description)}</span>` : ''}
      ${whoHtml(group)}
      ${group.active ? '' : '<span class="tag tag--gray">비활성</span>'}
      ${openBtn(group, '업무항목')}
      <span class="pm-tools">${textBtn('sheet', '복제', `data-dup="${esc(group.id)}"`)}</span>`
        : `<span class="pm-head__desc">${division
            ? (isUnsorted ? '업무구분이 정해지지 않은 업무항목입니다. ✎ 로 업무구분을 고르세요'
                : '왼쪽에서 업무항목을 고르거나 「업무항목」 을 추가하세요')
            : '왼쪽에서 업무구분을 추가해 시작하세요'}</span>`}
      <div class="pm-head__actions">
        ${segHtml('seg-pane', [['nav', '구성'], ['flow', '흐름'], ['side', '설명']], state.pane)}
        ${templates.map((name) => `<span class="pm-tools">${textBtn('checklist', `견본: ${name}`, `data-seed="${esc(name)}"`)}</span>`).join('')}
        ${group ? textBtn('memo', '설명', 'id="btn-side"', `btn btn--sm pm-sidebtn ${state.side ? 'btn--primary' : ''}`) : ''}
        <button class="btn btn--sm ${state.edit ? 'btn--primary' : ''}" type="button" id="btn-edit">
          ${icon('edit', 'icon icon--sm')}<span>${state.edit ? '편집 끝' : '편집'}</span></button>
        ${group ? textBtn('sheet', '인쇄', 'id="btn-print"') : ''}
      </div>
    </header>
    ${guideHtml(state, group)}
    ${gvm ? canvasHtml(gvm, state) : ''}
    ${gvm && state.edit && !state.link ? quickBar(gvm.item, true) : ''}
  </section>
  ${sideHtml(gvm, state)}
</div>`;

    if (gvm) layoutCanvas(body, gvm, { edit: state.edit });
    watchCanvas(body, gvm, state.edit);

    body.querySelectorAll('[data-nav-div]').forEach((el) => {
        el.addEventListener('click', () => {
            if (state.division === el.dataset.navDiv) return;
            state.division = el.dataset.navDiv;
            state.group = null;
            resetEdit(state);
            reload();
        });
    });
    body.querySelectorAll('[data-nav-grp]').forEach((el) => {
        el.addEventListener('click', () => {
            state.division = el.dataset.navIn;
            state.group = el.dataset.navGrp;
            resetEdit(state);
            state.pick = null;
            if (state.pane === 'nav') state.pane = 'flow';
            reload();
        });
    });
    body.querySelector('#btn-edit').addEventListener('click', () => {
        state.edit = !state.edit;
        resetEdit(state);
        reload();
    });
    body.querySelector('#btn-side')?.addEventListener('click', () => {
        state.side = !state.side;
        reload();
    });
    body.querySelectorAll('#seg-pane [data-seg]').forEach((el) => {
        el.addEventListener('click', () => {
            state.pane = el.dataset.seg;
            reload();
        });
    });
    /** 카드 머리를 누르면 상세를 펼치고 접는다 (버튼·토글·손잡이는 제외) */
    body.querySelectorAll('[data-toggle]').forEach((el) => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('button, input, label, select, .pm-grip')) return;
            const id = el.dataset.toggle;
            if (state.open.has(id)) state.open.delete(id);
            else state.open.add(id);
            // 도식에서 고른 단계는 우측 설명 표도 그 단계로 옮겨 준다
            if (el.dataset.pick) state.pick = el.dataset.pick;
            reload();
        });
    });
    /** 인쇄는 상세를 모두 펼친 매뉴얼로 - 끝나면 원래 펼침 상태로 돌린다 */
    body.querySelector('#btn-print')?.addEventListener('click', async () => {
        const prev = new Set(state.open);
        rows.forEach((r) => state.open.add(r.id));
        await reload();
        // 인쇄는 화면 폭이 아니라 A4 폭에 맞춰 다시 배치한다 (열이 화면보다 좁아진다)
        if (shown) layoutCanvas(shown.body, shown.gvm, { width: PRINT_W, edit: false });
        document.body.classList.add('cl-printing');
        const off = () => {
            document.body.classList.remove('cl-printing');
            window.removeEventListener('afterprint', off);
            state.open = prev;
            reload();
        };
        window.addEventListener('afterprint', off);
        window.print();
    });

    const formCtx = { state, user, users, divisions, rows, findItem, reload };
    body.querySelector('#btn-add-division')
        .addEventListener('click', () => openForm({ kind: CHECK_KIND.DIVISION }, formCtx));
    body.querySelectorAll('[data-add]').forEach((el) => {
        el.addEventListener('click', () => {
            openForm({ parentId: el.dataset.add, kind: el.dataset.kind }, formCtx);
        });
    });
    body.querySelectorAll('[data-open]').forEach((el) => {
        el.addEventListener('click', () => {
            const item = findItem(el.dataset.open);
            if (item) openForm({ item, parentId: item.parent_id, kind: item.kind }, formCtx);
        });
    });
    body.querySelector('[data-dup]')?.addEventListener('click', async () => {
        const msg = `「${group.title}」 을(를) 단계·상황·체크항목과 흐름까지 통째로 복제할까요?`;
        if (!(await confirmDialog(msg))) return;
        try {
            const r = await db.duplicateChecklistGroup(group.id, user);
            state.group = r.group.id;
            toast(`「${r.group.title}」 으로 항목 ${num(r.count)}개를 복제했습니다.`, 'success');
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
    body.querySelectorAll('[data-seed]').forEach((el) => {
        el.addEventListener('click', async () => {
            const name = el.dataset.seed;
            const msg = `「${division.title}」 아래에 「${name}」 견본 업무항목을 만들까요?\n`
                + '만든 뒤 자유롭게 고칠 수 있습니다.';
            if (!(await confirmDialog(msg))) return;
            try {
                const r = await db.seedChecklistTemplate(name, division.id, user);
                state.group = r.group.id;
                toast(`항목 ${num(r.count)}개를 등록했습니다.`, 'success');
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
    bindGrip(body, state, () => {
        if (gvm) layoutCanvas(body, gvm, { edit: state.edit });
    });
    bindQuick(body, state, user, reload);
    if (state.edit && group) {
        bindStep(body, state, group, user, reload);
        bindLink(body, state, user, reload);
        bindEdge(body, gvm, user, reload);
        bindDrag(body, user, reload);
    }
}

/** 편집 중이던 상태(연결 모드·다음 단계 입력칸·빠른 추가)를 한꺼번에 접는다 */
function resetEdit(state) {
    state.link = null;
    state.step = null;
    state.quick = null;
}

/**
 * 연결 모드에서 **고를 수 없는 카드** 🔑 - 그렇게 이으면 흐름이 되돌아오는 곳이다.
 * `from → to` 가 순환이 되는 조건은 「to 에서 from 으로 닿는다」 = **from 의 선행자들**이라
 * `reachableFrom(..., {reverse:true})` 이 그대로 답이다. 자기 자신과 이미 이은 곳도 뺀다.
 */
async function prepLink(state, flow, group) {
    const from = state.link.fromId;
    if (!group || !flow?.order.includes(from)) {
        state.link = null;
        return;
    }
    const back = await db.reachableFrom(group.id, from, { reverse: true });
    state.link.block = new Set([...back, from, ...(flow.nexts[from] ?? [])]);
    const node = flow.nodes.find((n) => n.id === from);
    state.link.caption = `${circled(flow.no[from] ?? '')} ${node?.title ?? ''}`;
}

/** 편집 안내 - 연결 모드에서는 안내가 바뀐다 */
function guideHtml(state, group) {
    if (!state.edit || !group) return '';
    if (state.link) {
        return `
<p class="pm-guide pm-guide--link">
  ${icon('branch', 'icon icon--sm')}
  <b>${esc(state.link.caption)}</b> 뒤에 이을 단계를 고르세요.
  흐린 카드는 고를 수 없습니다 (그렇게 이으면 흐름이 되돌아옵니다).
  <span class="toolbar__spacer"></span>
  <button class="btn btn--sm" type="button" data-link-cancel>취소 (Esc)</button>
</p>`;
    }
    return `
<p class="pm-guide">
  위에서 아래로가 업무 순서입니다. 카드 아래 ${icon('plus', 'icon icon--sm')} 로 다음 단계를 만들고
  (이미 다음 단계가 있으면 한 번 더 눌러 <b>갈래</b>), ${icon('branch', 'icon icon--sm')} 로
  이미 있는 단계에 잇습니다 (<b>합류</b>).
  선 위 칩을 누르면 조건·갈래 순서·연결 끊기를 할 수 있습니다.
</p>`;
}

/* ------------------------------ 우측 설명 표 ------------------------------ */

/** 우측 구역 - 고른 단계의 설명 표가 들어갈 자리 */
function sideHtml(gvm, state) {
    if (!gvm) return '<aside class="pm-side"></aside>';
    return `
<aside class="pm-side">
  <div class="pm-side__grip" role="separator" aria-orientation="vertical" tabindex="0"
       aria-label="설명 구역 너비 조절" title="끌어서 너비 조절 (← → 키도 됩니다)"></div>
  <div class="pm-side__head">
    ${icon('memo', 'icon icon--sm')}<strong>${esc(gvm.item.title)}</strong>
  </div>
  <p class="pm-side__empty">${state.pick
        ? '설명 표는 다음 단계에서 붙입니다.'
        : '가운데에서 단계를 고르면 그 단계의 설명이 여기 나옵니다.'}</p>
</aside>`;
}

/* ----------------------------- 우측 구역 너비 조절 ----------------------------- */

/** 우측 설명 구역이 가질 수 있는 너비 (px). 가운데 도식이 쓸모를 잃지 않을 만큼만 허용한다 */
const SIDE_W = { min: 240, max: 640, nav: 230, flow: 420, step: 16 };

/**
 * 우측 구역 왼쪽 경계를 끌어 너비를 바꾼다 (← → 키로도 조절).
 * 정한 값은 state.sideW 에 남아 다른 화면에 다녀와도 유지된다.
 * 포인터는 손잡이에 가둬(setPointerCapture) window 리스너를 남기지 않는다.
 * @param {()=>void} done 너비가 정해진 뒤(끌기 종료·키 조작) 도식을 다시 배치한다.
 */
function bindGrip(body, state, done) {
    const pm = body.querySelector('.pm');
    const grip = body.querySelector('.pm-side__grip');
    const side = body.querySelector('.pm-side');
    if (!pm || !grip || !side) return;

    /** 가운데 도식과 좌측 트리가 쓸 폭을 남기고 자른다 */
    const fit = (w) => {
        const room = pm.offsetWidth - SIDE_W.nav - SIDE_W.flow;
        const max = Math.max(SIDE_W.min, Math.min(SIDE_W.max, room));
        return Math.round(Math.min(Math.max(w, SIDE_W.min), max));
    };
    const apply = (w) => {
        state.sideW = fit(w);
        pm.style.setProperty('--pm-side-w', `${state.sideW}px`);
    };

    let startX = 0;
    let startW = 0;
    grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        startW = side.offsetWidth;
        grip.setPointerCapture(e.pointerId);
        pm.classList.add('is-resizing');
    });
    grip.addEventListener('pointermove', (e) => {
        if (!grip.hasPointerCapture(e.pointerId)) return;
        apply(startW + (startX - e.clientX));   // 왼쪽으로 끌수록 넓어진다
    });
    const end = (e) => {
        if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
        pm.classList.remove('is-resizing');
        done();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        apply(side.offsetWidth + (e.key === 'ArrowLeft' ? SIDE_W.step : -SIDE_W.step));
        done();
    });
}

/* ------------------------------ 흐름 편집 (선 긋기) ------------------------------ */

/**
 * 카드 아래 ＋ - 다음 단계를 새로 만들어 잇는다.
 * 🔑 **갈래는 따로 만들지 않는다** - 다음 단계가 이미 있는 카드에서 한 번 더 누르면
 * 간선이 하나 더 생기고, 그것이 곧 갈래다 (db.addProcessEdge 가 순환만 막는다).
 * 등록한 뒤에는 **새 카드로 입력칸을 옮겨** 사슬을 계속 이어 만들 수 있게 한다.
 */
function bindStep(body, state, group, user, reload) {
    body.querySelectorAll('[data-next]').forEach((el) => {
        el.addEventListener('click', () => {
            state.step = { fromId: el.dataset.next };
            state.quick = null;
            reload();
        });
    });
    const form = body.querySelector('[data-next-form]');
    if (!form) return;
    const input = form.elements.title;
    input.focus();
    input.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        state.step = null;
        reload();
    });
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = input.value.trim();
        if (!title) return;
        try {
            const made = await db.createChecklistItem({
                kind: CHECK_KIND.PROCESS,
                title,
                parent_id: group.id,
                from_id: form.dataset.nextForm,
            }, user);
            state.step = { fromId: made.id };
            toast(`「${title}」 을(를) 이었습니다.`, 'success');
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

/**
 * 연결 모드 - ↳ 를 누르면 대상을 고르는 모드로 들어간다 (Esc 로 취소).
 * 고를 수 없는 카드는 `prepLink` 가 미리 흐리게 만들어 두었고, 그래도 눌리면 여기서 막는다.
 */
function bindLink(body, state, user, reload) {
    body.querySelectorAll('[data-link]').forEach((el) => {
        el.addEventListener('click', () => {
            state.link = { fromId: el.dataset.link };
            state.step = null;
            state.quick = null;
            reload();
        });
    });
    if (!state.link) return;
    const cancel = () => {
        state.link = null;
        reload();
    };
    body.querySelector('[data-link-cancel]')?.addEventListener('click', cancel);
    const onKey = (e) => {
        if (e.key === 'Escape') cancel();
    };
    document.addEventListener('keydown', onKey);
    offEsc = () => document.removeEventListener('keydown', onKey);

    body.querySelectorAll('[data-target]').forEach((el) => {
        el.addEventListener('click', async (e) => {
            if (e.target.closest('button')) return;      // ✎ 는 연결 모드에서도 속성 모달이다
            const to = el.dataset.target;
            if (state.link.block.has(to)) {
                toast('그 단계로는 이을 수 없습니다 (흐름이 되돌아오거나 이미 이어져 있습니다).', 'error');
                return;
            }
            try {
                await db.addProcessEdge(state.link.fromId, to, {}, user);
                state.link = null;
                toast('이었습니다.', 'success');
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/** 선 위 라벨 칩 - 조건 라벨 · 갈래 좌우 순서 · 연결 끊기 */
function bindEdge(body, gvm, user, reload) {
    const canvas = body.querySelector('.pm-canvas');
    if (!canvas || !gvm) return;
    // 칩은 배치할 때마다 다시 만들어지므로 위임으로 받는다 (리사이즈·인쇄에도 살아 있다)
    canvas.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-edge]');
        if (!chip) return;
        e.stopPropagation();
        openEdgePop(chip, gvm, user, reload);
    });
}

/** 간선 팝오버 - 칩 자리에 띄운다. 바깥을 누르거나 Esc 로 닫힌다 */
function openEdgePop(chip, gvm, user, reload) {
    closePop?.();
    const edge = gvm.edges.find((x) => x.id === chip.dataset.edge);
    if (!edge) return;
    const sibs = gvm.edges.filter((x) => x.from === edge.from)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const at = sibs.findIndex((x) => x.id === edge.id);
    const pop = document.createElement('div');
    pop.className = 'pm-epop';
    pop.style.left = chip.style.left;
    pop.style.top = chip.style.top;
    pop.innerHTML = `
<input type="text" maxlength="40" value="${esc(edge.label)}" data-elabel
       placeholder="조건 (예: 수출 건일 때)" aria-label="조건 라벨">
<div class="pm-epop__row">
  ${iconBtn('back', '갈래를 왼쪽으로', `data-ord="left" ${at <= 0 ? 'disabled' : ''}`)}
  ${iconBtn('forward', '갈래를 오른쪽으로', `data-ord="right" ${at >= sibs.length - 1 ? 'disabled' : ''}`)}
  <span class="toolbar__spacer"></span>
  ${textBtn('close', '연결 끊기', 'data-cut', 'btn btn--sm btn--danger')}
</div>`;
    chip.parentElement.appendChild(pop);
    const input = pop.querySelector('[data-elabel]');
    input.focus();
    input.select();

    const shut = () => {
        document.removeEventListener('pointerdown', onOut, true);
        document.removeEventListener('keydown', onKey);
        pop.remove();
        closePop = null;
    };
    const onOut = (e) => {
        if (!pop.contains(e.target)) shut();
    };
    const onKey = (e) => {
        if (e.key === 'Escape') shut();
    };
    document.addEventListener('pointerdown', onOut, true);
    document.addEventListener('keydown', onKey);
    closePop = shut;

    const run = async (fn) => {
        try {
            await fn();
            shut();
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    };
    input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        run(() => db.setEdgeLabel(edge.id, input.value, user));
    });
    pop.querySelectorAll('[data-ord]').forEach((el) => {
        el.addEventListener('click', () => {
            const to = el.dataset.ord === 'left' ? at - 1 : at + 1;
            const ids = sibs.map((x) => x.to);
            ids.splice(to, 0, ids.splice(at, 1)[0]);
            run(() => db.reorderEdges(edge.from, ids, user));
        });
    });
    pop.querySelector('[data-cut]').addEventListener('click', () => {
        run(() => db.removeProcessEdge(edge.id, user));
    });
}

/* -------------------------------- 빠른 추가 -------------------------------- */

/** 이름 입력 후 Enter. 등록 뒤에도 입력칸을 열어 둔다 (state.quick) */
function bindQuick(body, state, user, reload) {
    function openQuick(hostId, kind, label) {
        const bar = body.querySelector(`[data-quick-host="${CSS.escape(hostId)}"]`);
        if (!bar) return;
        state.quick = { hostId, kind, label };
        bar.innerHTML = `
<form class="pm-quick__form">
  <span class="tag tag--blue">${esc(label)}</span>
  <input type="text" name="title" maxlength="100" autocomplete="off"
         placeholder="이름을 입력하고 Enter (Esc 로 닫기)">
  <button class="btn btn--sm btn--primary" type="submit">추가</button>
  ${iconBtn('close', '닫기', 'data-quick-close')}
</form>`;
        const form = bar.querySelector('form');
        const input = form.elements.title;
        input.focus();
        const closeQuick = () => {
            state.quick = null;
            reload();
        };
        bar.querySelector('[data-quick-close]').addEventListener('click', closeQuick);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeQuick();
        });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const title = input.value.trim();
            if (!title) return;
            try {
                await db.createChecklistItem({
                    kind, title, parent_id: hostId, daily: kind === CHECK_KIND.CHECK,
                }, user);
                toast(`「${title}」 을(를) 추가했습니다.`, 'success');
                await reload();          // state.quick 이 남아 있어 같은 자리에 입력칸이 다시 열린다
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }
    body.querySelectorAll('[data-quick]').forEach((el) => {
        el.addEventListener('click', () => {
            openQuick(el.dataset.quick, el.dataset.kind, el.dataset.label);
        });
    });
    if (state.quick && body.querySelector(`[data-quick-host="${CSS.escape(state.quick.hostId)}"]`)) {
        openQuick(state.quick.hostId, state.quick.kind, state.quick.label);
    } else {
        state.quick = null;
    }
}

/**
 * 드래그 정렬 - 손잡이(pm-grip)를 잡아야 끌린다 (입력칸 글자 선택과 부딪히지 않게).
 * 같은 상위(data-parent)·같은 종류(data-kind) 사이에서만 놓을 수 있다.
 * 🔑 **프로세스 단계는 대상이 아니다** - 순서는 간선이 정한다 (카드에 data-item 이 없다).
 */
function bindDrag(body, user, reload) {
    let drag = null;
    const clearMarks = () => body.querySelectorAll('.is-drop-before, .is-drop-after')
        .forEach((x) => x.classList.remove('is-drop-before', 'is-drop-after'));
    const before = (el, e) => {
        const r = el.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
    };

    body.querySelectorAll('.pm-grip').forEach((grip) => {
        const el = grip.closest('[data-item]');
        if (!el) return;
        grip.addEventListener('mousedown', () => el.setAttribute('draggable', 'true'));
        grip.addEventListener('touchstart', () => el.setAttribute('draggable', 'true'),
            { passive: true });
    });

    body.querySelectorAll('[data-item][data-parent]').forEach((el) => {
        el.addEventListener('dragstart', (e) => {
            if (el.getAttribute('draggable') !== 'true') return;
            e.stopPropagation();
            drag = { id: el.dataset.item, parent: el.dataset.parent, kind: el.dataset.kind };
            el.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', el.dataset.item);
        });
        el.addEventListener('dragend', () => {
            el.classList.remove('is-dragging');
            el.removeAttribute('draggable');
            clearMarks();
            drag = null;
        });
        const accepts = () => drag && drag.id !== el.dataset.item
            && drag.parent === el.dataset.parent && drag.kind === el.dataset.kind;
        el.addEventListener('dragover', (e) => {
            if (!accepts()) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            clearMarks();
            el.classList.add(before(el, e) ? 'is-drop-before' : 'is-drop-after');
        });
        el.addEventListener('drop', async (e) => {
            if (!accepts()) return;
            e.preventDefault();
            e.stopPropagation();
            const isBefore = before(el, e);
            const sel = `[data-item][data-parent="${CSS.escape(drag.parent)}"]`
                + `[data-kind="${CSS.escape(drag.kind)}"]`;
            const ids = [...body.querySelectorAll(sel)].map((x) => x.dataset.item)
                .filter((id) => id !== drag.id);
            const at = ids.indexOf(el.dataset.item);
            ids.splice(isBefore ? at : at + 1, 0, drag.id);
            const parentId = drag.parent;
            clearMarks();
            try {
                await db.reorderChecklistItems(parentId, ids, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}
