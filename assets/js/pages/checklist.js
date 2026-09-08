/**
 * 업무체크리스트 화면.
 *
 *   탭1 오늘 할 일 - 그 날짜에 해야 할 항목을 구분별로 보고 체크한다
 *   탭2 항목 관리 - 마인드맵(세로 트리)으로 항목을 등록·정렬·수정한다 (manageChecklist)
 *
 * 주기 판정·권한 판정은 화면이 하지 않는다. db.dueItems() · db.canCheckItem() 이 준
 * 결과만 그린다 (docs/checklist.md). 앱 화면(mobile/screens/checklist.js)도 같은 함수를 쓴다.
 */
import { can } from '../auth.js';
import * as db from '../db.js';
import { icon } from '../icons.js';
import {
    CHECK_CATEGORIES, CHECK_CYCLE, CHECK_CYCLES, WEEKDAYS, cycleLabel,
} from '../config.js';
import {
    esc, num, rate, toast, today, addDays, fmtDateTime, confirmDialog, promptDialog,
} from '../util.js';

/** 화면 상태 - 다른 화면에 다녀와도 유지한다 */
const state = {
    tab: 'today',
    date: today(),
    assignee: 'me',                    // 'me' | 'all' | 사용자 id
    category: CHECK_CATEGORIES[0],
    collapsed: new Set(),              // 항목 관리 탭에서 접어 둔 노드 id
};

/** 수시 항목을 모으는 묶음 이름 - 날짜와 무관해 구분 카드와 따로 둔다 */
const ADHOC_GROUP = CHECK_CYCLES[CHECK_CYCLE.ADHOC];

/** 아이콘 버튼 한 개 - 문구 대신 아이콘만 두므로 aria-label·title 로 뜻을 알린다 */
function iconBtn(name, label, attr, cls = 'btn btn--icon btn--sm') {
    return `<button class="${cls}" type="button" ${attr}
        aria-label="${esc(label)}" title="${esc(label)}">${icon(name, 'icon icon--sm')}</button>`;
}

export async function render(root, { user }) {
    const canManage = can(user, 'manageChecklist');
    if (!canManage && state.tab === 'manage') state.tab = 'today';

    const TABS = [
        { key: 'today', label: '오늘 할 일' },
        ...(canManage ? [{ key: 'manage', label: '항목 관리' }] : []),
    ];

    root.innerHTML = `
<div class="card">
  <div class="card__head">
    <h2>업무체크리스트</h2>
    <span class="tag tag--gray" id="head-sum"></span>
  </div>
  <div class="tabs" id="cl-tabs"></div>
  <div class="card__body" id="cl-body"></div>
</div>`;

    const body = root.querySelector('#cl-body');
    const headSum = root.querySelector('#head-sum');
    let users = [];

    function drawTabs() {
        root.querySelector('#cl-tabs').innerHTML = TABS.map((t) => `
<button class="tabs__btn ${t.key === state.tab ? 'is-active' : ''}"
        type="button" data-tab="${t.key}">${esc(t.label)}</button>`).join('');
        root.querySelectorAll('[data-tab]').forEach((el) => {
            el.addEventListener('click', () => {
                state.tab = el.dataset.tab;
                reload();
            });
        });
    }

    async function reload() {
        users = (await db.listUsers()).filter((u) => u.active !== false);
        drawTabs();
        if (state.tab === 'manage') {
            headSum.textContent = '';
            await drawManage(body, user, users, reload);
        } else {
            await drawToday(body, headSum, user, users, canManage, reload);
        }
    }

    /**
     * 실시간 갱신 - **편집 중에는 다시 그리지 않는다.**
     * 5초마다 통째로 다시 그리면 열어 둔 인라인 폼과 입력하던 값이 사라진다.
     */
    function guarded() {
        const el = document.activeElement;
        if (el && body.contains(el) && el.matches('input, textarea, select')) return;
        if (body.querySelector('.cl-form')) return;
        reload();
    }

    await reload();
    return db.subscribe(guarded);
}

/* ============================== 탭1 오늘 할 일 ============================== */

/** 담당자 필터를 db 조회 조건으로 바꾼다 ('나' 는 로그인 사용자) */
function assigneeFilter(user) {
    if (state.assignee === 'all') return {};
    return { assignee: state.assignee === 'me' ? user.id : state.assignee };
}

async function drawToday(body, headSum, user, users, canManage, reload) {
    const f = assigneeFilter(user);
    const rows = await db.dueItems(state.date, f);
    const sum = await db.checklistSummary(state.date, f);
    const pct = rate(sum.done, sum.total);

    headSum.textContent = `${num(sum.done)} / ${num(sum.total)}`;

    // 수시는 날짜와 무관하므로 구분 카드가 아니라 마지막에 따로 모은다
    const groups = CHECK_CATEGORIES
        .map((c) => ({
            name: c,
            rows: rows.filter((r) => r.category === c && r.cycle !== CHECK_CYCLE.ADHOC),
        }))
        .concat([{ name: ADHOC_GROUP, rows: rows.filter((r) => r.cycle === CHECK_CYCLE.ADHOC) }])
        .filter((g) => g.rows.length);

    body.innerHTML = `
<div class="toolbar">
  <div class="cl-datenav">
    ${iconBtn('back', '이전 날짜', 'id="btn-prev"')}
    <input type="date" id="f-date" value="${esc(state.date)}" aria-label="날짜">
    ${iconBtn('next', '다음 날짜', 'id="btn-next"')}
    <button class="btn btn--sm" id="btn-today" type="button">오늘</button>
  </div>
  <label class="field" style="flex:0 0 180px">
    <span class="field__label">담당자</span>
    <select id="f-assignee" ${canManage ? '' : 'disabled'}>
      <option value="me" ${state.assignee === 'me' ? 'selected' : ''}>나</option>
      ${canManage ? `
      <option value="all" ${state.assignee === 'all' ? 'selected' : ''}>전체</option>
      ${users.map((u) => `
      <option value="${esc(u.id)}" ${state.assignee === u.id ? 'selected' : ''}
        >${esc(u.name)}</option>`).join('')}` : ''}
    </select>
  </label>
  <div class="toolbar__spacer"></div>
  <div class="cl-progress">
    <span class="cl-progress__num">${num(sum.done)} / ${num(sum.total)}</span>
    <div class="bar"><div class="bar__fill ${pct === 100 ? 'is-done' : ''}"
      style="width:${pct}%"></div></div>
  </div>
  ${sum.missed ? `
  <button class="btn btn--sm cl-missed" id="btn-missed" type="button"
    >어제 미체크 ${num(sum.missed)}건</button>` : ''}
</div>
<div class="cl-groups">
  ${groups.length ? groups.map((g) => `
  <section class="cl-group">
    <h3 class="cl-group__head">${esc(g.name)}
      <span class="tag tag--gray">${num(g.rows.filter((r) => r.check).length)} / ${num(g.rows.length)}</span>
    </h3>
    <div class="cl-group__body">${g.rows.map((r) => itemRow(r, user)).join('')}</div>
  </section>`).join('')
        : '<p class="empty">이 날짜에 해야 할 항목이 없습니다.</p>'}
</div>`;

    body.querySelector('#btn-prev').addEventListener('click', () => {
        state.date = addDays(state.date, -1);
        reload();
    });
    body.querySelector('#btn-next').addEventListener('click', () => {
        state.date = addDays(state.date, 1);
        reload();
    });
    body.querySelector('#btn-today').addEventListener('click', () => {
        state.date = today();
        reload();
    });
    body.querySelector('#f-date').addEventListener('change', (e) => {
        state.date = e.target.value || today();
        reload();
    });
    body.querySelector('#f-assignee').addEventListener('change', (e) => {
        state.assignee = e.target.value;
        reload();
    });
    body.querySelector('#btn-missed')?.addEventListener('click', () => {
        state.date = sum.prevDate;
        reload();
    });

    body.querySelectorAll('[data-check]').forEach((el) => {
        el.addEventListener('change', async () => {
            const row = rows.find((r) => r.id === el.dataset.check);
            try {
                await db.setCheck(row.id, state.date, el.checked, row.check?.memo ?? '', user);
                await reload();
            } catch (err) {
                el.checked = !el.checked;
                toast(err.message, 'error');
            }
        });
    });
    body.querySelectorAll('[data-title]').forEach((el) => {
        el.addEventListener('click', () => {
            body.querySelector(`[data-check="${el.dataset.title}"]:not([disabled])`)?.click();
        });
    });
    body.querySelectorAll('[data-memo]').forEach((el) => {
        el.addEventListener('click', async () => {
            const row = rows.find((r) => r.id === el.dataset.memo);
            if (!row.check) {
                toast('체크한 뒤에 메모를 남길 수 있습니다.', 'info');
                return;
            }
            const memo = await promptDialog('메모 (비우면 지워집니다)', row.check.memo ?? '');
            if (memo === null) return;
            try {
                await db.setCheck(row.id, state.date, true, memo, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/** 오늘 할 일 한 줄 - 체크 권한이 없으면 회색 조회 상태가 된다 */
function itemRow(r, user) {
    const locked = !db.canCheckItem(user, r);
    const done = !!r.check;
    return `
<div class="cl-item ${done ? 'is-done' : ''} ${locked ? 'is-locked' : ''}">
  <input type="checkbox" data-check="${esc(r.id)}" ${done ? 'checked' : ''}
         ${locked ? 'disabled' : ''} aria-label="${esc(r.title)}">
  <span class="cl-item__title" data-title="${esc(r.id)}">
    ${r.path ? `<span class="cl-item__path">${esc(r.path)}</span>` : ''}
    ${esc(r.title)}
  </span>
  <span class="cl-item__cycle">${esc(cycleLabel(r))}</span>
  <span class="cl-item__who">${esc(r.assignee_name || '미지정')}</span>
  <span class="cl-item__done">${done
        ? `${esc(fmtDateTime(r.check.checked_at).slice(11))} ${esc(r.check.checked_by_name)}`
        : ''}</span>
  ${iconBtn('memo', r.check?.memo ? `메모: ${r.check.memo}` : '메모',
        `data-memo="${esc(r.id)}"`,
        `btn btn--icon btn--sm ${r.check?.memo ? 'is-on' : ''}`)}
</div>`;
}

/* ============================== 탭2 항목 관리 ============================== */

async function drawManage(body, user, users, reload) {
    const rows = await db.listChecklistItems({
        category: state.category, includeInactive: true,
    });
    const tree = db.checklistTree(rows);

    body.innerHTML = `
<div class="tabs tabs--sub" id="cl-cats">
  ${CHECK_CATEGORIES.map((c) => `
  <button class="tabs__btn ${c === state.category ? 'is-active' : ''}"
          type="button" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
</div>
<div class="cl-tree" id="cl-tree">
  ${tree.length ? tree.map(nodeHtml).join('')
        : '<p class="empty">등록된 항목이 없습니다.</p>'}
</div>
<div data-slot="root"></div>
<button class="btn btn--primary btn--sm" id="btn-add-root" type="button">
  ${icon('plus', 'icon icon--sm')}<span>최상위 항목 추가</span></button>`;

    body.querySelectorAll('[data-cat]').forEach((el) => {
        el.addEventListener('click', () => {
            state.category = el.dataset.cat;
            reload();
        });
    });

    /** 슬롯에 인라인 폼을 연다. slotId 는 부모 노드 id 또는 'root' */
    function openForm(slotId, item, parentId) {
        body.querySelectorAll('[data-slot]').forEach((s) => { s.innerHTML = ''; });
        const slot = body.querySelector(`[data-slot="${slotId}"]`);
        if (!slot) return;
        slot.innerHTML = formHtml(item, users);
        const form = slot.querySelector('form');

        const sync = () => {
            const cycle = form.elements.cycle.value;
            form.querySelector('[data-when="weekly"]').hidden = cycle !== CHECK_CYCLE.WEEKLY;
            form.querySelector('[data-when="monthly"]').hidden = cycle !== CHECK_CYCLE.MONTHLY;
        };
        form.elements.cycle.addEventListener('change', sync);
        sync();

        form.querySelector('[data-cancel]').addEventListener('click', () => {
            slot.innerHTML = '';
        });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = new FormData(form);
            const payload = {
                title: f.get('title'),
                description: f.get('description'),
                cycle: f.get('cycle'),
                weekday: Number(f.get('weekday')),
                monthday: Number(f.get('monthday')),
                assignee_id: f.get('assignee_id') || null,
                active: f.get('active') === 'on',
                category: state.category,
                parent_id: parentId ?? null,
            };
            try {
                if (item) await db.updateChecklistItem(item.id, payload, user);
                else await db.createChecklistItem(payload, user);
                toast(item ? '항목을 수정했습니다.' : '항목을 등록했습니다.', 'success');
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    body.querySelector('#btn-add-root')
        .addEventListener('click', () => openForm('root', null, null));

    body.querySelectorAll('[data-toggle]').forEach((el) => {
        el.addEventListener('click', () => {
            const id = el.dataset.toggle;
            if (state.collapsed.has(id)) state.collapsed.delete(id);
            else state.collapsed.add(id);
            reload();
        });
    });
    body.querySelectorAll('[data-add]').forEach((el) => {
        el.addEventListener('click', () => {
            state.collapsed.delete(el.dataset.add);
            openForm(el.dataset.add, null, el.dataset.add);
        });
    });
    body.querySelectorAll('[data-edit]').forEach((el) => {
        el.addEventListener('click', () => {
            const item = rows.find((r) => r.id === el.dataset.edit);
            openForm(item.id, item, item.parent_id);
        });
    });
    body.querySelectorAll('[data-move]').forEach((el) => {
        el.addEventListener('click', async () => {
            try {
                await db.moveChecklistItem(el.dataset.move, el.dataset.dir, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
    body.querySelectorAll('[data-del]').forEach((el) => {
        el.addEventListener('click', async () => {
            const item = rows.find((r) => r.id === el.dataset.del);
            const kids = rows.filter((r) => r.parent_id === item.id).length;
            const msg = kids
                ? `하위 항목 ${kids}개도 함께 삭제됩니다. 계속할까요?`
                : '이 항목을 삭제할까요?';
            if (!(await confirmDialog(msg))) return;
            try {
                await db.deleteChecklistItem(item.id, user);
                toast('항목을 삭제했습니다.', 'success');
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/** 트리 한 노드 - 자식은 접혀 있지 않을 때만 그린다 */
function nodeHtml(node) {
    const { item, depth, children } = node;
    const folded = state.collapsed.has(item.id);
    return `
<div class="cl-node ${item.active ? '' : 'is-off'}" style="padding-left:${depth * 22}px">
  ${children.length
        ? iconBtn(folded ? 'next' : 'down', folded ? '펼치기' : '접기',
            `data-toggle="${esc(item.id)}"`, 'btn btn--icon btn--sm btn--ghost')
        : '<span class="cl-node__gap"></span>'}
  <span class="cl-node__title">${esc(item.title)}</span>
  ${children.length ? '' : `<span class="cl-node__cycle">${esc(cycleLabel(item))}</span>`}
  <span class="cl-node__who">${esc(item.assignee_name || '')}</span>
  ${item.active ? '' : '<span class="tag tag--gray">비활성</span>'}
  <span class="toolbar__spacer"></span>
  ${iconBtn('plus', '하위 항목 추가', `data-add="${esc(item.id)}"`)}
  ${iconBtn('up', '위로', `data-move="${esc(item.id)}" data-dir="up"`)}
  ${iconBtn('down', '아래로', `data-move="${esc(item.id)}" data-dir="down"`)}
  ${iconBtn('edit', '항목 수정', `data-edit="${esc(item.id)}"`)}
  ${iconBtn('trash', '항목 삭제', `data-del="${esc(item.id)}"`,
        'btn btn--icon btn--sm btn--danger')}
</div>
<div data-slot="${esc(item.id)}"></div>
${folded ? '' : children.map(nodeHtml).join('')}`;
}

/** 인라인 편집 폼 - 등록과 수정이 같은 마크업을 쓴다 */
function formHtml(item, users) {
    const cycle = item?.cycle ?? CHECK_CYCLE.DAILY;
    return `
<form class="cl-form">
  <label class="field">
    <span class="field__label">항목명 *</span>
    <input type="text" name="title" required maxlength="100" value="${esc(item?.title ?? '')}">
  </label>
  <label class="field">
    <span class="field__label">설명</span>
    <input type="text" name="description" maxlength="200"
           value="${esc(item?.description ?? '')}">
  </label>
  <label class="field" style="flex:0 0 110px">
    <span class="field__label">주기</span>
    <select name="cycle">
      ${Object.entries(CHECK_CYCLES).map(([k, v]) => `
      <option value="${esc(k)}" ${k === cycle ? 'selected' : ''}>${esc(v)}</option>`).join('')}
    </select>
  </label>
  <label class="field" data-when="weekly" style="flex:0 0 90px">
    <span class="field__label">요일</span>
    <select name="weekday">
      ${WEEKDAYS.map((w, i) => `
      <option value="${i}" ${i === Number(item?.weekday ?? 1) ? 'selected' : ''}
        >${esc(w)}</option>`).join('')}
    </select>
  </label>
  <label class="field" data-when="monthly" style="flex:0 0 90px">
    <span class="field__label">일자</span>
    <input type="number" name="monthday" min="1" max="31" value="${Number(item?.monthday ?? 1)}">
  </label>
  <label class="field" style="flex:0 0 140px">
    <span class="field__label">담당자</span>
    <select name="assignee_id">
      <option value="">미지정</option>
      ${users.map((u) => `
      <option value="${esc(u.id)}" ${u.id === item?.assignee_id ? 'selected' : ''}
        >${esc(u.name)}</option>`).join('')}
    </select>
  </label>
  <label class="check">
    <input type="checkbox" name="active" ${item?.active === false ? '' : 'checked'}>
    <span>활성</span>
  </label>
  <span class="toolbar__spacer"></span>
  ${iconBtn('close', '취소', 'data-cancel')}
  <button class="btn btn--icon btn--sm btn--primary" type="submit"
          aria-label="저장" title="저장">${icon('save', 'icon icon--sm')}</button>
</form>`;
}
