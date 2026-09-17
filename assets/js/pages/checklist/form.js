/**
 * 업무프로세스 탭의 속성 모달 - 종류별 폼 + 삭제 · 순서(↑↓).
 * 등록(item 없음)과 수정(item 있음)이 같은 폼을 쓴다.
 *
 * 종류별 필드는 docs/checklist.md 의 표와 같다. 업무항목·프로세스는 **하위 프로세스 연결
 * 방식(순차/갈래)** 을 함께 고른다 (config.js 의 CHECK_FLOW).
 */
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import {
    CHECK_CYCLE, CHECK_CYCLES, CHECK_FLOW, CHECK_FLOWS, CHECK_KIND, CHECK_KINDS, WEEKDAYS,
} from '../../config.js';
import { esc, num, toast, confirmDialog, openModal } from '../../util.js';
import { UNSORTED_ID, iconBtn, textBtn } from './common.js';

/**
 * 속성 모달을 연다.
 * @param {{item?:object, parentId?:string|null, kind:string}} o
 * @param {{state:object, user:object, users:Array, divisions:Array, rows:Array,
 *          findItem:Function, reload:Function}} ctx 화면이 넘겨 주는 문맥
 */
export function openForm({ item = null, parentId = null, kind }, ctx) {
    const { state, user, users, divisions, rows, findItem, reload } = ctx;
    const parent = parentId ? findItem(parentId) : null;
    const label = CHECK_KINDS[kind];
    const m = openModal(`${label} ${item ? '수정' : '추가'}`,
        formHtml(item, kind, parent, users, divisions), {
            footer: `
<div class="pm-mfoot">
  ${item ? `
  <button class="btn btn--sm btn--danger" type="button" data-del>${icon('trash', 'icon icon--sm')}<span>삭제</span></button>
  <span class="pm-mfoot__order">순서
    ${iconBtn('up', '순서 위로', 'data-move="up"')}
    ${iconBtn('down', '순서 아래로', 'data-move="down"')}</span>` : ''}
  <span class="toolbar__spacer"></span>
  <button class="btn btn--sm" type="button" data-cancel>취소</button>
  <button class="btn btn--sm btn--primary" type="submit" form="pm-form">${icon('save', 'icon icon--sm')}<span>저장</span></button>
</div>`,
        });
    const form = m.body.querySelector('form');
    const sync = () => {
        if (!form.elements.cycle) return;
        const cycle = form.elements.cycle.value;
        form.querySelector('[data-when="weekly"]').hidden = cycle !== CHECK_CYCLE.WEEKLY;
        form.querySelector('[data-when="monthly"]').hidden = cycle !== CHECK_CYCLE.MONTHLY;
    };
    form.elements.cycle?.addEventListener('change', sync);
    sync();
    form.elements.title.focus();
    m.root.querySelector('[data-cancel]').addEventListener('click', m.close);

    // 부담당자 - 「+」 로 줄을 더하고 ✕ 로 뺀다 (줄은 동적으로 생기므로 폼에 위임)
    form.querySelector('[data-add-sub]').addEventListener('click', () => {
        form.querySelector('[data-subs]')
            .insertAdjacentHTML('beforeend', subRowHtml(users, ''));
        form.querySelector('[data-subs] .cl-subs__row:last-child select').focus();
    });
    form.addEventListener('click', (e) => {
        const del = e.target.closest('[data-del-sub]');
        if (del) del.closest('.cl-subs__row').remove();
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        const payload = {
            kind,
            title: f.get('title'),
            description: f.get('description'),
            cycle: f.get('cycle') ?? CHECK_CYCLE.DAILY,
            weekday: Number(f.get('weekday') ?? 1),
            monthday: Number(f.get('monthday') ?? 1),
            assignee_id: f.get('assignee_id') || null,
            sub_assignee_ids: f.getAll('sub_assignee_ids').filter(Boolean),
            active: f.get('active') === 'on',
            daily: f.get('daily') === 'on',
            // 업무항목은 폼에서 업무구분을 고른다 (수정 시 다른 업무구분으로 옮길 수 있다)
            parent_id: kind === CHECK_KIND.GROUP && f.has('parent_id')
                ? (f.get('parent_id') || null) : (parentId ?? null),
        };
        if (f.has('child_flow')) payload.child_flow = f.get('child_flow');
        try {
            if (item) {
                await db.updateChecklistItem(item.id, payload, user);
                if (kind === CHECK_KIND.GROUP && payload.parent_id) {
                    state.division = payload.parent_id;
                }
            } else {
                const made = await db.createChecklistItem(payload, user);
                if (kind === CHECK_KIND.DIVISION) state.division = made.id;
                if (kind === CHECK_KIND.GROUP) {
                    state.division = payload.parent_id ?? UNSORTED_ID;
                    state.group = made.id;
                }
            }
            toast(item ? '수정했습니다.' : '등록했습니다.', 'success');
            m.close();
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
    m.root.querySelectorAll('[data-move]').forEach((el) => {
        el.addEventListener('click', async () => {
            try {
                await db.moveChecklistItem(item.id, el.dataset.move, user);
                await reload();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
    m.root.querySelector('[data-del]')?.addEventListener('click', async () => {
        const kids = item.kind === CHECK_KIND.DIVISION || item.kind === CHECK_KIND.GROUP
            ? (await db.listChecklistItems({ root: item.id, includeInactive: true })).length - 1
            : countDescendants(rows, item.id);
        const msg = kids
            ? `${label} 「${item.title}」 아래 항목 ${num(kids)}개도 함께 삭제됩니다. 계속할까요?`
            : `${label} 「${item.title}」을(를) 삭제할까요?`;
        if (!(await confirmDialog(msg))) return;
        try {
            await db.deleteChecklistItem(item.id, user);
            toast('삭제했습니다.', 'success');
            m.close();
            await reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

/** 하위 항목 수 (자기 제외) */
export function countDescendants(rows, id) {
    return rows.filter((r) => r.parent_id === id)
        .reduce((n, r) => n + 1 + countDescendants(rows, r.id), 0);
}

/** 부담당자 한 줄 - 사용자 선택 + 빼기 */
function subRowHtml(users, curId) {
    return `
<div class="cl-subs__row">
  <select name="sub_assignee_ids">
    <option value="">선택</option>
    ${users.map((u) => `
    <option value="${esc(u.id)}" ${u.id === curId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
  </select>
  ${iconBtn('close', '부담당자 빼기', 'data-del-sub')}
</div>`;
}

/** 속성 폼 - 종류에 따라 필드가 다르다 (등록·수정 같은 마크업). 모달 안에 세로로 놓인다 */
function formHtml(item, kind, parent, users, divisions = []) {
    const cycle = item?.cycle ?? CHECK_CYCLE.DAILY;
    const isCheck = kind === CHECK_KIND.CHECK;
    const isSit = kind === CHECK_KIND.SITUATION;
    const isGroup = kind === CHECK_KIND.GROUP;
    // 하위 프로세스를 둘 수 있는 종류만 연결 방식을 고른다
    const hasFlow = isGroup || kind === CHECK_KIND.PROCESS;
    const flow = item?.child_flow ?? CHECK_FLOW.SEQ;
    // 업무항목은 흐름의 맨 위라 모일 다음 형제가 없다 - 합류를 고를 수 있으면 조용히 갈래로 동작한다
    const flowOpts = Object.entries(CHECK_FLOWS)
        .filter(([k]) => !(isGroup && k === CHECK_FLOW.JOIN));
    const titleLabel = {
        [CHECK_KIND.DIVISION]: '업무구분 이름',
        [CHECK_KIND.GROUP]: '업무항목 이름',
        [CHECK_KIND.PROCESS]: '프로세스명',
        [CHECK_KIND.SITUATION]: '상황명',
        [CHECK_KIND.CHECK]: '항목명',
    }[kind];
    const descLabel = {
        [CHECK_KIND.DIVISION]: '설명',
        [CHECK_KIND.GROUP]: '설명',
        [CHECK_KIND.PROCESS]: '설명',
        [CHECK_KIND.SITUATION]: '어떤 때인지 (대응 요령)',
        [CHECK_KIND.CHECK]: '설명',
    }[kind];
    const placeholder = {
        [CHECK_KIND.DIVISION]: '예: 입고, 출고, 반품',
        [CHECK_KIND.GROUP]: '예: B2B출고, B2C출고',
        [CHECK_KIND.PROCESS]: '예: 입고검수',
        [CHECK_KIND.SITUATION]: '예: 입고수량오류',
        [CHECK_KIND.CHECK]: '예: LOT 확인',
    }[kind] ?? '';
    const curParent = parent?.id ?? '';
    return `
<form class="cl-form" id="pm-form">
  ${parent && !isGroup ? `<p class="cl-form__parent">${esc(CHECK_KINDS[parent.kind])} 「${esc(parent.title)}」 아래</p>` : ''}
  <label class="field field--full">
    <span class="field__label">${esc(titleLabel)} *</span>
    <input type="text" name="title" required maxlength="100" value="${esc(item?.title ?? '')}"
           placeholder="${esc(placeholder)}">
  </label>
  ${isGroup ? `
  <label class="field field--full">
    <span class="field__label">업무구분</span>
    <select name="parent_id" ${divisions.length ? 'required' : ''}>
      ${curParent ? '' : '<option value="">미분류</option>'}
      ${divisions.map((d) => `
      <option value="${esc(d.id)}" ${d.id === curParent ? 'selected' : ''}>${esc(d.title)}</option>`).join('')}
    </select>
  </label>` : ''}
  <label class="field field--full">
    <span class="field__label">${esc(descLabel)}</span>
    <input type="text" name="description" maxlength="200"
           value="${esc(item?.description ?? '')}">
  </label>
  ${hasFlow ? `
  <label class="field field--full">
    <span class="field__label">하위 프로세스 연결 (갈래면 번호 대신 갈래 이름으로 읽습니다)</span>
    <select name="child_flow">
      ${flowOpts.map(([k, v]) => `
      <option value="${esc(k)}" ${k === flow ? 'selected' : ''}>${esc(v)}</option>`).join('')}
    </select>
  </label>` : ''}
  ${isCheck ? `
  <label class="field">
    <span class="field__label">주기</span>
    <select name="cycle">
      ${Object.entries(CHECK_CYCLES).map(([k, v]) => `
      <option value="${esc(k)}" ${k === cycle ? 'selected' : ''}>${esc(v)}</option>`).join('')}
    </select>
  </label>
  <label class="field" data-when="weekly">
    <span class="field__label">요일</span>
    <select name="weekday">
      ${WEEKDAYS.map((w, i) => `
      <option value="${i}" ${i === Number(item?.weekday ?? 1) ? 'selected' : ''}
        >${esc(w)}</option>`).join('')}
    </select>
  </label>
  <label class="field" data-when="monthly">
    <span class="field__label">일자</span>
    <input type="number" name="monthday" min="1" max="31" value="${Number(item?.monthday ?? 1)}">
  </label>` : ''}
  <label class="field">
    <span class="field__label">정담당자${isSit || isCheck ? '' : ' (아래 항목이 따릅니다)'}</span>
    <select name="assignee_id">
      <option value="">${parent || isGroup ? '상위 담당 따름' : '공통'}</option>
      ${users.map((u) => `
      <option value="${esc(u.id)}" ${u.id === item?.assignee_id ? 'selected' : ''}
        >${esc(u.name)}</option>`).join('')}
    </select>
  </label>
  <div class="field">
    <span class="field__label">부담당자 (여러 명 · 정담당자 대신 체크할 수 있습니다)</span>
    <div class="cl-subs" data-subs>
      ${(item?.sub_assignees ?? []).map((s) => subRowHtml(users, s.id)).join('')}
    </div>
    ${textBtn('plus', '부담당자 추가', 'data-add-sub', 'btn btn--sm pm-add')}
  </div>
  <div class="cl-form__checks">
    ${isCheck || kind === CHECK_KIND.PROCESS ? `
    <label class="check" title="${isCheck ? '켜면 일일체크리스트에 나옵니다' : '체크항목이 없는 단계일 때 단계 자체를 일일체크리스트에 넣습니다'}">
      <input type="checkbox" name="daily" ${item ? (item.daily ? 'checked' : '') : (isCheck ? 'checked' : '')}>
      <span>일일체크리스트 포함</span>
    </label>` : ''}
    <label class="check">
      <input type="checkbox" name="active" ${item?.active === false ? '' : 'checked'}>
      <span>활성</span>
    </label>
  </div>
</form>`;
}
