/**
 * 업무프로세스 탭 - 세 칸 화면.
 *
 *   좌 pm-nav     업무구분 › 업무항목 (등록·선택)
 *   중 pm-canvas  흐름 도식 (flowview.js · 카드 + SVG 선)
 *   우 pm-side    고른 업무항목의 **체크리스트 표** (프로세스 · 체크리스트 · 담당자)
 *
 * 우측 표는 새 데이터가 아니라 **kind='check' 노드를 표로 편집**하는 것이다.
 * 추가는 표 아래 폼에서 프로세스를 골라 그 아래 체크항목을 만들고, 담당자는 assignee_id 다.
 * 좁은 화면에서는 우측을 먼저 접고(서랍), 더 좁으면 세그먼트로 한 칸씩 본다 (app.css).
 */
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import { CHECK_KIND, CHECK_TEMPLATES, cycleLabel } from '../../config.js';
import { esc, num, toast, confirmDialog } from '../../util.js';
import {
    UNSORTED_ID, iconBtn, openBtn, quickBar, segHtml, stepCaption, textBtn, whoHtml,
} from './common.js';
import { canvasHtml, groupVM, layoutCanvas, looseHtml } from './flowview.js';
import { openForm } from './form.js';

/** 인쇄용 가용폭 (px) - A4 세로에서 여백을 뺀 대략치. 열이 1~2개면 여유롭게 들어간다 */
const PRINT_W = 680;

/** 지금 그려져 있는 도식 - 창 리사이즈·인쇄가 카드를 다시 그리지 않고 좌표만 다시 잡는다 */
let shown = null;

/** 화면을 떠날 때 창 리사이즈 구독을 끊는다 (checklist.js 의 정리 함수가 부른다) */
export function disposeManage() {
    shown?.off();
    shown = null;
}

/**
 * 도식 재배치 구독 🔑 - 창 리사이즈는 **디바운스로 한 번만** 한다.
 * 서랍 여닫기·세그먼트 전환·드래그 정렬은 화면을 통째로 다시 그리므로 여기서 따로 걸지 않는다.
 */
function watchCanvas(body, gvm) {
    disposeManage();
    if (!gvm) return;
    let timer = null;
    const onResize = () => {
        clearTimeout(timer);
        timer = setTimeout(() => layoutCanvas(body, gvm), 150);
    };
    window.addEventListener('resize', onResize);
    shown = {
        body,
        gvm,
        off: () => {
            clearTimeout(timer);
            window.removeEventListener('resize', onResize);
        },
    };
}

export async function drawManage(ctx) {
    const { state, body, user, users, reload } = ctx;
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
    const tree = group ? db.checklistTree(rows)[0] : null;
    const gvm = tree ? groupVM(tree) : null;
    const templates = (division && !isUnsorted ? Object.keys(CHECK_TEMPLATES) : [])
        .filter((name) => !groups.some((g) => g.title === name));
    const allGroups = Object.values(groupsBy).flat();
    const findItem = (id) => rows.find((r) => r.id === id)
        ?? allGroups.find((g) => g.id === id)
        ?? divisions.find((d) => d.id === id);

    body.className = `card__body cl-manage ${state.edit ? 'is-edit' : ''}`;
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
        ${segHtml('seg-pane', [['nav', '구성'], ['flow', '흐름'], ['side', '체크리스트']], state.pane)}
        ${templates.map((name) => `<span class="pm-tools">${textBtn('checklist', `견본: ${name}`, `data-seed="${esc(name)}"`)}</span>`).join('')}
        ${group ? textBtn('checklist', '체크리스트', 'id="btn-side"', `btn btn--sm pm-sidebtn ${state.side ? 'btn--primary' : ''}`) : ''}
        <button class="btn btn--sm ${state.edit ? 'btn--primary' : ''}" type="button" id="btn-edit">
          ${icon('edit', 'icon icon--sm')}<span>${state.edit ? '편집 끝' : '편집'}</span></button>
        ${group ? textBtn('sheet', '인쇄', 'id="btn-print"') : ''}
      </div>
    </header>
    ${state.edit && group ? `
    <p class="pm-guide">
      위에서 아래로가 업무 순서입니다 (오른쪽으로 벌어지면 갈래, 들여쓰기는 순차 하위).
      카드의 ${icon('menu', 'icon icon--sm')} 를 끌어 순서를 바꾸고,
      ${icon('edit', 'icon icon--sm')} 로 이름·담당자·주기·${icon('branch', 'icon icon--sm')} 갈래 여부를 고칩니다.
      「+ 체크항목」 「+ 상황」 은 이름을 적고 Enter 만 누르면 바로 들어갑니다.
    </p>` : ''}
    ${gvm ? canvasHtml(gvm, state) : ''}
    ${gvm ? looseHtml(gvm, state) : ''}
    ${gvm && state.edit ? quickBar(gvm.item, true) : ''}
  </section>
  ${gvm ? sideHtml(gvm, users, state) : '<aside class="pm-side"></aside>'}
</div>`;

    if (gvm) layoutCanvas(body, gvm);
    watchCanvas(body, gvm);

    body.querySelectorAll('[data-nav-div]').forEach((el) => {
        el.addEventListener('click', () => {
            if (state.division === el.dataset.navDiv) return;
            state.division = el.dataset.navDiv;
            state.group = null;
            state.quick = null;
            reload();
        });
    });
    body.querySelectorAll('[data-nav-grp]').forEach((el) => {
        el.addEventListener('click', () => {
            state.division = el.dataset.navIn;
            state.group = el.dataset.navGrp;
            state.quick = null;
            state.pick = null;
            if (state.pane === 'nav') state.pane = 'flow';
            reload();
        });
    });
    body.querySelector('#btn-edit').addEventListener('click', () => {
        state.edit = !state.edit;
        state.quick = null;
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
            // 도식에서 고른 프로세스는 우측 표에서 그 구간으로 옮겨 준다
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
        if (shown) layoutCanvas(shown.body, shown.gvm, { width: PRINT_W });
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
        const msg = `「${group.title}」 을(를) 프로세스·상황·체크항목까지 통째로 복제할까요?`;
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
    body.querySelectorAll('[data-daily]').forEach((el) => {
        el.addEventListener('change', async () => {
            try {
                await db.updateChecklistItem(el.dataset.daily, { daily: el.checked }, user);
                await reload();
            } catch (err) {
                el.checked = !el.checked;
                toast(err.message, 'error');
            }
        });
    });

    bindSide(body, state, user, reload);
    bindGrip(body, state, () => {
        if (gvm) layoutCanvas(body, gvm);
    });
    bindQuick(body, state, user, reload);
    if (state.edit) bindDrag(body, user, reload);

    // 도식에서 고른 프로세스의 구간을 우측 표에서 보여 준다
    if (state.pick) {
        body.querySelector(`[data-pick-row="${CSS.escape(state.pick)}"]`)
            ?.scrollIntoView({ block: 'nearest' });
    }
}

/* ------------------------------ 우측 체크리스트 표 ------------------------------ */

/** 표 한 구간 - 프로세스(또는 상황) 하나와 그 아래 체크항목들 */
function sideSections(gvm) {
    const out = [];
    const walk = (p, path) => {
        const here = [...path, { title: p.item.title, no: p.no, sit: false }];
        out.push({ host: p.item, path: here, checks: p.rows });
        p.subs.forEach((s) => walk(s, here));
        p.situations.forEach((s) => {
            const sPath = [...here, { title: s.item.title, no: null, sit: true }];
            out.push({ host: s.item, path: sPath, checks: s.rows });
            s.subs.forEach((sp) => walk(sp, sPath));
        });
    };
    gvm.processes.forEach((p) => walk(p, []));
    out.push({ host: gvm.item, path: [], checks: gvm.loose });
    return out;
}

/** 구간 머리 - `② 입고거래명세서 확인` · 상황이면 주황 */
function pathCell(sec) {
    if (!sec.path.length) return '<span class="pm-side__loose">단독 업무</span>';
    const last = sec.path[sec.path.length - 1];
    const up = sec.path.slice(0, -1)
        .map((n) => (n.sit ? esc(n.title) : stepCaption(n))).join(' › ');
    const head = last.sit
        ? `${icon('issues', 'icon icon--sm')}${esc(last.title)}`
        : stepCaption(last);
    return `${up ? `<small>${up}</small>` : ''}
<span class="${last.sit ? 'is-sit' : ''}">${head}</span>`;
}

/** 담당자 선택 칸 - 비우면 상위 담당을 따른다 */
function whoSelect(r, users) {
    return `
<select class="pm-side__who" data-cassignee="${esc(r.id)}">
  <option value="">상위 따름</option>
  ${users.map((u) => `
  <option value="${esc(u.id)}" ${u.id === r.assignee_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
</select>`;
}

/** 구간 경로를 평문으로 - 추가 폼의 선택 항목 라벨 (stepCaption 이 이미 이스케이프한다) */
function pathText(sec) {
    if (!sec.path.length) return '단독 업무';
    return sec.path.map((n) => (n.sit ? esc(n.title) : stepCaption(n))).join(' › ');
}

/** 우측 체크리스트 등록 구역 */
function sideHtml(gvm, users, state) {
    const all = sideSections(gvm);
    const sections = all.filter((s) => s.checks.length || s.path.length);
    const rowsHtml = sections.map((sec) => {
        const picked = sec.host.id === state.pick ? 'is-picked' : '';
        if (!sec.checks.length) {
            return `
<tr class="${picked}" data-pick-row="${esc(sec.host.id)}">
  <td class="pm-side__proc">${pathCell(sec)}</td>
  <td class="pm-side__none" colspan="2">아직 없습니다</td>
</tr>`;
        }
        return sec.checks.map((r, i) => `
<tr class="${picked}" ${i ? '' : `data-pick-row="${esc(sec.host.id)}"`}>
  ${i ? '' : `<td class="pm-side__proc" rowspan="${sec.checks.length}">${pathCell(sec)}</td>`}
  <td class="pm-side__name">
    <div class="pm-side__cell">
      <input type="text" value="${esc(r.title)}" maxlength="100" data-ctitle="${esc(r.id)}"
             aria-label="체크리스트 이름" class="${r.daily ? '' : 'is-skip'}"
             title="${esc(r.daily ? cycleLabel(r) : `${cycleLabel(r)} · 일일 제외`)}">
      ${openBtn(r, '체크항목')}
    </div>
  </td>
  <td>${whoSelect(r, users)}</td>
</tr>`).join('');
    }).join('');
    return `
<aside class="pm-side">
  <div class="pm-side__grip" role="separator" aria-orientation="vertical" tabindex="0"
       aria-label="체크리스트 구역 너비 조절" title="끌어서 너비 조절 (← → 키도 됩니다)"></div>
  <div class="pm-side__head">
    ${icon('checklist', 'icon icon--sm')}<strong>체크리스트</strong>
    <small>${esc(gvm.item.title)}</small>
  </div>
  <table class="pm-side__tbl">
    <thead><tr><th>프로세스</th><th>체크리스트</th><th>담당자</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="3" class="pm-side__empty">프로세스를 먼저 등록하세요.</td></tr>'}</tbody>
  </table>
  ${addHtml(all, state)}
</aside>`;
}

/**
 * 표 아래 추가 폼 - 어느 프로세스에 달지 고른 뒤 이름을 넣는다.
 * 고른 값은 state.pick 에 담아 중앙 도식의 강조와 같이 움직인다.
 */
function addHtml(all, state) {
    if (!all.length) return '';
    const opts = all.map((s) => `
    <option value="${esc(s.host.id)}" ${s.host.id === state.pick ? 'selected' : ''}>
      ${pathText(s)}</option>`).join('');
    return `
<div class="pm-side__add">
  <select data-cnew-proc aria-label="프로세스 선택">${opts}</select>
  <div class="pm-side__addrow">
    <input type="text" data-cnew-title maxlength="100" placeholder="체크리스트 이름"
           aria-label="체크리스트 이름" autocomplete="off">
    ${textBtn('plus', '추가', 'data-cnew-go', 'btn btn--sm btn--primary')}
  </div>
</div>`;
}

/**
 * 우측 표 편집 - 이름은 입력칸에서 바로, 담당자는 선택.
 * 추가는 표 아래 폼에서 프로세스를 고른 뒤 이름을 넣는다 (Enter 또는 추가 버튼).
 * 기존 db 함수만 쓴다 (체크항목 등록·수정은 createChecklistItem · updateChecklistItem).
 */
function bindSide(body, state, user, reload) {
    const side = body.querySelector('.pm-side');
    if (!side) return;
    // 실시간 갱신이 입력하던 값을 지우지 않게 표시해 둔다 (checklist.js 의 guarded)
    side.addEventListener('input', (e) => {
        if (e.target.matches('input')) e.target.classList.add('is-dirty');
    });
    side.querySelectorAll('[data-ctitle]').forEach((el) => {
        el.addEventListener('change', async () => {
            const title = el.value.trim();
            if (!title) {
                toast('이름을 입력하세요.', 'error');
                await reload();
                return;
            }
            try {
                await db.updateChecklistItem(el.dataset.ctitle, { title }, user);
                el.classList.remove('is-dirty');
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
    side.querySelectorAll('[data-cassignee]').forEach((el) => {
        el.addEventListener('change', async () => {
            try {
                await db.updateChecklistItem(el.dataset.cassignee,
                    { assignee_id: el.value || null }, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
    const proc = side.querySelector('[data-cnew-proc]');
    const title = side.querySelector('[data-cnew-title]');
    if (!proc || !title) return;
    // 고른 프로세스를 state.pick 에 담아 둔다 - 다시 그려도 선택이 풀리지 않는다
    proc.addEventListener('change', () => { state.pick = proc.value; });
    /** 고른 프로세스 아래에 체크항목을 만든다 */
    const add = async () => {
        const name = title.value.trim();
        if (!name) {
            title.focus();
            return;
        }
        try {
            await db.createChecklistItem({
                kind: CHECK_KIND.CHECK, title: name, parent_id: proc.value, daily: true,
            }, user);
            title.value = '';
            title.classList.remove('is-dirty');
            toast(`「${name}」 을(를) 추가했습니다.`, 'success');
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    };
    side.querySelector('[data-cnew-go]')?.addEventListener('click', add);
    title.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        add();
    });
}

/* ----------------------------- 우측 구역 너비 조절 ----------------------------- */

/** 우측 체크리스트 구역이 가질 수 있는 너비 (px). 가운데 도식이 쓸모를 잃지 않을 만큼만 허용한다 */
const SIDE_W = { min: 240, max: 640, nav: 230, flow: 420, step: 16 };

/**
 * 우측 구역 왼쪽 경계를 끌어 너비를 바꾼다 (← → 키로도 조절).
 * 정한 값은 state.sideW 에 남아 다른 화면에 다녀와도 유지된다.
 * 포인터는 손잡이에 가둬(setPointerCapture) window 리스너를 남기지 않는다.
 * @param {()=>void} done 너비가 정해진 뒤(끌기 종료·키 조작) 도식을 다시 배치한다.
 *   끄는 동안 매 프레임 다시 재지 않는다 - 카드 높이를 다시 재는 일이라 무겁다
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
