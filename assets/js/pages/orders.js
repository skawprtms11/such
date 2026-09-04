/** 주문정보등록 화면 - 화주 영업사원이 출고 주문을 게시판 형태로 등록/수정한다 */
import {
    VEHICLE_TYPES, ORDER_STATE, YN, YN_LIST,
    ORDER_POLICY, ADJUST_CATEGORIES, adjustCategory,
    RESTORE_TYPE, RESTORE_TYPE_LABEL, RESTORE_REASONS,
} from '../config.js';
import { can, allow } from '../auth.js';
import { currentStep, loadDone } from '../steps.js';
import * as db from '../db.js';
import {
    esc, num, today, toDateStr, downloadCsv, toast, openModal, confirmDialog, fmtDateTime,
    seqTag, addBadge,
} from '../util.js';

/** 조회 필터 상태 */
const filter = { from: '', to: '', keyword: '' };

export async function render(root, { user }) {
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);
    filter.from = filter.from || toDateStr(monthAgo);
    filter.to = filter.to || today();

    root.innerHTML = `
<div class="card">
  <div class="card__head">
    <h2>주문 등록 내역</h2>
    <span class="tag tag--gray" id="row-count"></span>
    <div class="toolbar__spacer"></div>
    <div class="btn-row" id="head-actions"></div>
  </div>
  <div class="card__body">
    <div class="toolbar">
      <label class="field" style="max-width:150px">
        <span class="field__label">등록일 시작</span>
        <input type="date" id="f-from" value="${filter.from}">
      </label>
      <label class="field" style="max-width:150px">
        <span class="field__label">등록일 종료</span>
        <input type="date" id="f-to" value="${filter.to}">
      </label>
      <label class="field" style="max-width:220px">
        <span class="field__label">주문번호 / 거래처명</span>
        <input type="text" id="f-kw" placeholder="검색어 입력" value="${esc(filter.keyword)}">
      </label>
      <button class="btn" id="btn-search" type="button">조회</button>
    </div>
    <div class="table-wrap"><table class="grid" id="tbl"></table></div>
  </div>
</div>`;

    const actions = root.querySelector('#head-actions');
    if (can(user, 'download')) {
        actions.insertAdjacentHTML('beforeend',
            '<button class="btn btn--sm" id="btn-csv" type="button">다운로드</button>');
    }
    if (canWrite(user)) {
        actions.insertAdjacentHTML('beforeend',
            '<button class="btn btn--danger btn--sm" id="btn-del-picked" type="button" disabled>'
            + '선택 삭제</button>'
            + '<button class="btn btn--sm" id="btn-bulk" type="button">일괄등록</button>'
            + '<button class="btn btn--primary btn--sm" id="btn-new" type="button">주문 등록</button>');
    }

    let rows = [];      // 주문 전체 (다운로드는 주문별로 풀어서 내려준다)
    let groups = [];    // 대표주문번호 묶음 - 목록은 묶음당 1행이다 (차수는 묶지 않는다)

    /** 목록 조회 후 요약/표 갱신 */
    async function reload() {
        rows = await db.listOrders({
            ...filter,
            createdBy: can(user, 'viewAll') ? undefined : user.id,
        });
        groups = db.repGroups(rows);
        const [stats, users] = await Promise.all([db.checkStats(), db.listUsers()]);
        // 담당자(등록자) 이름 조회용 맵
        const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
        drawTable(root, groups, user, reload, stats, names);
        root.querySelector('#row-count').textContent =
            `${num(groups.length)}건 (주문 ${num(rows.length)}개)`;
    }

    root.querySelector('#btn-search').addEventListener('click', () => {
        filter.from = root.querySelector('#f-from').value;
        filter.to = root.querySelector('#f-to').value;
        filter.keyword = root.querySelector('#f-kw').value;
        reload();
    });

    root.querySelector('#f-kw').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') root.querySelector('#btn-search').click();
    });

    root.querySelector('#btn-csv')?.addEventListener('click', async () => {
        const [counts, users] = await Promise.all([db.countRestores(), db.listUsers()]);
        const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
        downloadCsv(`주문등록내역_${today()}.csv`,
            ['연번', '등록일자', '전송일자', '담당자', '차수', '대표주문번호', '주문번호', '거래처명',
                '추가작업', '패킹리스트', '요청사항', '출고요청일', '상태', '작업지시',
                '수정횟수', '조정요청', '출고형태', '팀명', '품목수', '출고수량', '비고'],
            rows.map((o, i) => [
                i + 1, o.reg_date, o.send_date, names[o.created_by] ?? '',
                `${o.seq}차수`, o.rep_no ?? '', o.order_no, o.customer,
                o.extra_yn, o.packing_yn,
                o.request_note, o.ship_req_date || '미정', stateOf(o), o.work_note,
                o.edit_count ? `${o.edit_count}회` : '',
                counts[o.id] ? `${counts[o.id]}건` : '',
                o.vehicle_type, o.team_name, o.item_count, o.qty, o.remark,
            ]));
    });

    // 일괄삭제 - 표에서 체크한 행(묶음이면 멤버 전부)을 지운다
    root.querySelector('#btn-del-picked')?.addEventListener('click', async () => {
        const ids = pickedIds(root);
        if (!ids.length) return;
        const nos = groups.filter((g) => g.rows.some((r) => ids.includes(r.id)))
            .map((g) => g.head.rep_no || g.head.order_no);
        const ok = await confirmDialog(
            `선택한 ${nos.length}건(주문 ${ids.length}개)을 삭제하시겠습니까?\n\n`
            + `${nos.slice(0, 5).join(', ')}${nos.length > 5 ? ` 외 ${nos.length - 5}건` : ''}\n\n`
            + '삭제한 주문은 되돌릴 수 없습니다.',
        );
        if (!ok) return;
        let done = 0;
        try {
            for (const id of ids) {
                await db.deleteOrder(id, user);
                done += 1;
            }
            toast(`${done}개 주문을 삭제했습니다.`, 'success');
        } catch (err) {
            toast(`${done}개 삭제 후 중단: ${err.message}`, 'error');
        }
        reload();
    });

    root.querySelector('#btn-new')?.addEventListener('click', () => openForm(null, user, reload));
    root.querySelector('#btn-bulk')?.addEventListener('click', () => openBulkForm(user, reload));

    await reload();
    return db.subscribe(reload);
}

/**
 * 작성 권한 (등록·수정·조정요청).
 * 관리자·화주관리자는 항상, 그 외 역할은 소속이 고객사일 때만 가능하다.
 */
function canWrite(user) {
    return allow(user, ORDER_POLICY.write);
}

/**
 * 확인 권한 (확인 컬럼 체크, 이력의 확인처리).
 * 관리자·화주관리자는 항상, 그 외 역할은 소속이 용마로지스일 때만 가능하다.
 */
function canConfirm(user) {
    return allow(user, ORDER_POLICY.confirm);
}

/**
 * 수정 가능 여부 - 상차완료 전까지만 수정할 수 있다.
 * 🔑 취소된 주문도 수정 폼을 열 수 있다. 조정요청 '전체취소' 로 취소한 뒤
 * 내용을 고치거나 **삭제**해야 하는 경우가 있어서다 (삭제 버튼은 수정 폼 안에 있다).
 */
function canEdit(user, o) {
    return canWrite(user) && !loadDone(o);
}

/**
 * 조정요청 가능 여부 - 검수작업 완료 전까지만 요청할 수 있다.
 * 검수가 끝난 뒤에는 되돌릴 수 없으므로 이슈등록으로 처리한다.
 */
function canRestore(user, o) {
    return canWrite(user) && !o.inspect_done_at && !o.canceled_at;
}

/**
 * 패킹리스트 작성 가능 여부.
 * 주문 등록 시 패킹리스트가 '있음' 인 주문만 대상이며,
 * 상차완료·취소된 주문은 더 이상 고치지 않는다.
 * 고객사(등록)·용마로지스(확인) 양쪽 모두 작성할 수 있다.
 */
function canPacking(user, o) {
    return o.packing_yn === YN.YES && !loadDone(o) && !o.canceled_at
        && (canWrite(user) || canConfirm(user));
}

const EMPTY_STAT = { edits: 0, editsLeft: 0, restores: 0, restoresLeft: 0 };

/**
 * 주문번호 우측 위에 붙는 건수 배지.
 * 수정 + 조정요청 합계를 보여주고, 확인처리가 남았는지에 따라 색이 달라진다.
 *   초록 : 모두 확인처리됨
 *   빨강 : 확인처리가 1건이라도 남음
 */
function countBadge(stat = EMPTY_STAT) {
    const st = stat ?? EMPTY_STAT;
    const total = st.edits + st.restores;
    if (!total) return '';
    const left = st.editsLeft + st.restoresLeft;
    const tip = `수정 ${st.edits}건 · 조정요청 ${st.restores}건`
        + (left ? ` · 미확인 ${left}건` : ' · 모두 확인');
    return `<sup class="cnt-badge ${left ? 'is-pending' : 'is-done'}"
        title="${esc(tip)}">${total}</sup>`;
}

/**
 * 확인 셀 - 계산된 주문 상태(대기·접수·진행·취소·완료) 배지 하나.
 * 접수는 상세 팝업에서 작업지시를 작성해야 처리된다 (체크 방식은 제거했다).
 */
function stateCell(o, stat = EMPTY_STAT, state = stateOf(o)) {
    const st = stat ?? EMPTY_STAT;
    const cls = {
        [ORDER_STATE.WAIT]: 'tag--gray',
        [ORDER_STATE.ACCEPTED]: 'tag--blue',
        [ORDER_STATE.DOING]: 'tag--amber',
        [ORDER_STATE.DONE]: 'tag--green',
        [ORDER_STATE.CANCELED]: 'tag--red tag--canceled',
    }[state];

    const left = st.editsLeft + st.restoresLeft;
    let tip = '';
    if (state === ORDER_STATE.CANCELED && o.canceled_at) {
        tip = `${fmtDateTime(o.canceled_at)}${o.canceled_by_name ? ` · ${o.canceled_by_name}` : ''}`;
    } else if (o.confirmed_at) {
        const by = o.confirmed_by_name ? ` · ${o.confirmed_by_name}` : '';
        tip = `접수 ${fmtDateTime(o.confirmed_at)}${by}`;
    } else {
        tip = '상세 팝업에서 작업지시를 작성하면 접수됩니다';
    }
    if (left) tip += ` · 수정·조정 미확인 ${left}건`;

    return `<span class="tag ${cls}" title="${esc(tip)}">${state}</span>`;
}

/**
 * 확인 컬럼의 주문 상태.
 * 저장된 값이 아니라 주문 상태에서 계산한다.
 *   취소 > 완료(상차완료) > 진행(출고작업 착수) > 접수(작업지시 작성) > 대기
 */
function stateOf(o) {
    if (o.canceled_at) return ORDER_STATE.CANCELED;
    if (loadDone(o)) return ORDER_STATE.DONE;
    if (o.ship_started_at || o.ship_done_at) return ORDER_STATE.DOING;
    if (o.confirmed_at) return ORDER_STATE.ACCEPTED;
    return ORDER_STATE.WAIT;
}

/**
 * 묶음의 요약 상태 - **가장 뒤처진 주문**을 따른다 (대기 < 접수 < 진행 < 완료).
 * 취소는 묶인 주문이 전부 취소되었을 때만 표시한다.
 */
function groupState(list) {
    if (list.every((o) => o.canceled_at)) return ORDER_STATE.CANCELED;
    const rank = [ORDER_STATE.WAIT, ORDER_STATE.ACCEPTED, ORDER_STATE.DOING, ORDER_STATE.DONE];
    return list.filter((o) => !o.canceled_at)
        .map(stateOf)
        .sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0];
}

/** 묶음의 확인 현황 합계 (수정·조정요청 건수 배지에 쓴다) */
function groupStat(list, stats) {
    return list.reduce((a, o) => {
        const st = stats[o.id] ?? EMPTY_STAT;
        return {
            edits: a.edits + st.edits,
            editsLeft: a.editsLeft + st.editsLeft,
            restores: a.restores + st.restores,
            restoresLeft: a.restoresLeft + st.restoresLeft,
        };
    }, { ...EMPTY_STAT });
}

/**
 * 주문번호 셀 - 대표주문번호가 있으면 그것을 굵게 보여주고 `+N건` 배지를 붙인다.
 * 묶인 주문번호는 툴팁으로 확인한다.
 * 🔑 배지 수와 툴팁은 **취소되지 않은 주문만** 센다 (취소건은 상세 팝업에서 확인한다).
 */
function groupNoCell(g, head = g.head) {
    const live = g.rows.filter((o) => !o.canceled_at);
    const list = live.length ? live : g.rows;
    const tip = list.length > 1 ? `묶인 주문: ${list.map((o) => o.order_no).join(', ')}` : '';
    const no = esc(head.rep_no || head.order_no);
    return `<span class="link" data-detail="${head.id}" title="${esc(tip)}">${
        head.rep_no ? `<b>${no}</b>` : no}</span>${addBadge(list.length)}`;
}

/** 있음/없음 셀 - '있음' 만 파란 태그로 눈에 띄게 한다 */
function ynCell(v) {
    return v === YN.YES
        ? `<span class="tag tag--blue">${YN.YES}</span>`
        : `<span class="muted">${YN.NO}</span>`;
}

/**
 * 패킹리스트 셀 - 등록 시 '있음' 인 주문만 작성 버튼이 붙는다.
 * 아직 안 썼으면 파란 `작성`, 내용이 있으면 초록 `작성완료` 버튼이다.
 * 🔑 내용(`packing_note`)은 모바일 검수작업 탭과 같은 값이라
 *    현장에서 작성해도 이 컬럼이 바로 `작성완료` 로 바뀐다.
 * '없음' 이면 예전처럼 없음 표시만 남는다.
 */
function packingCell(o, user) {
    if (o.packing_yn !== YN.YES) return `<span class="muted">${YN.NO}</span>`;
    const written = Boolean((o.packing_note ?? '').trim());
    if (canPacking(user, o)) {
        return `<button class="btn btn--sm ${written ? 'btn--success' : 'btn--primary'}"
            data-packing="${o.id}" type="button"
            title="${written ? '작성된 패킹리스트를 확인·수정합니다' : '패킹리스트를 작성합니다'}"
            >${written ? '작성완료' : '작성'}</button>`;
    }
    return written
        ? '<span class="tag tag--green">작성완료</span>'
        : '<span class="tag tag--gray">미작성</span>';
}

/**
 * 패킹리스트 작성 팝업 - 패킹리스트 컬럼의 작성/수정 버튼으로 연다.
 * 내용을 텍스트로 쓰고 그 자리에서 수정·저장한다.
 */
function openPackingNoteModal(o, user, onSaved) {
    const written = Boolean((o.packing_note ?? '').trim());
    const m = openModal(`패킹리스트 ${written ? '수정' : '작성'} - ${o.order_no}`, `
<p class="form-note" style="margin-top:0">
  ${esc(o.customer)} · 출고요청일 ${o.ship_req_date || '미정'} · ${o.seq}차수
</p>
<label class="field">
  <span class="field__label">패킹리스트 내용</span>
  <textarea id="packing-note-input" rows="12"
            placeholder="패킹리스트 내용을 작성하세요">${esc(o.packing_note ?? '')}</textarea>
</label>
<p class="form-note">출고주문처리(모바일) 검수작업 탭과 <b>같은 내용</b>입니다.
현장에서 작성·수정한 내용도 이 창에 그대로 나오고, 저장하면 수정이력에 남습니다.</p>
<div class="form-actions">
  <button class="btn" id="btn-note-cancel" type="button">취소</button>
  <button class="btn btn--primary" id="btn-note-save" type="button">저장</button>
</div>`, { wide: true });
    const input = m.body.querySelector('#packing-note-input');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    m.body.querySelector('#btn-note-cancel').addEventListener('click', m.close);
    m.body.querySelector('#btn-note-save').addEventListener('click', async () => {
        try {
            await db.setPackingNote(o.id, input.value, user);
            m.close();
            toast(`패킹리스트를 ${written ? '수정' : '저장'}했습니다.`, 'success');
            onSaved();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

/** 게시판 형태 목록 렌더링 - 대표주문번호 묶음당 1행이다 (묶이지 않은 주문은 1건이 1행) */
function drawTable(root, groups, user, reload, stats = {}, names = {}) {
    const tbl = root.querySelector('#tbl');
    if (!groups.length) {
        tbl.innerHTML = '<tbody><tr><td class="empty">조회된 주문이 없습니다.</td></tr></tbody>';
        return;
    }
    tbl.innerHTML = `
<thead><tr>
  ${canWrite(user) ? '<th class="center"><input type="checkbox" id="chk-all" title="전체 선택"></th>' : ''}
  <th class="num">연번</th><th>등록일자</th><th>전송일자</th>
  <th class="center">담당자</th><th class="center">차수</th>
  <th>주문번호</th><th>거래처명</th>
  <th class="center">추가작업</th><th class="center">패킹리스트</th><th>지시사항</th>
  <th>출고요청일</th><th class="center">확인</th>
</tr></thead>
<tbody>
${groups.map((g, i) => {
        const list = g.rows;
        // 대표가 취소된 묶음은 살아 있는 주문을 대표로 보여준다
        const o = list.find((r) => !r.canceled_at) ?? g.head;
        // 추가작업·패킹리스트는 묶음 중 하나라도 '있음' 이면 있음으로 본다
        const extraYn = list.some((r) => r.extra_yn === YN.YES) ? YN.YES : YN.NO;
        const packingOrder = list.find((r) => r.packing_yn === YN.YES) ?? o;
        const stat = groupStat(list, stats);
        return `
<tr class="${list.every((r) => r.canceled_at) ? 'is-canceled' : ''}">
  ${canWrite(user) ? `<td class="center">${pickBox(list, user)}</td>` : ''}
  <td class="num">${groups.length - i}</td>
  <td>${o.reg_date}</td>
  <td>${o.send_date}</td>
  <td class="center">${esc(names[o.created_by] ?? '-')}</td>
  <td class="center">${seqTag(o.seq)}</td>
  <td>${groupNoCell(g, o)}${countBadge(stat)}</td>
  <td>${esc(o.customer)}</td>
  <td class="center">${ynCell(extraYn)}</td>
  <td class="center">${packingCell(packingOrder, user)}</td>
  <td class="wrap">${esc(o.work_note)}</td>
  <td>${o.ship_req_date || '미정'}</td>
  <td class="center">${stateCell(o, stat, groupState(list))}</td>
</tr>`;
    }).join('')}
</tbody>`;

    tbl.querySelectorAll('[data-detail]').forEach((el) => {
        el.addEventListener('click', () => showDetail(el.dataset.detail, user, reload));
    });
    // 체크박스 - 전체 선택과 개별 선택이 선택 삭제 버튼을 켜고 끈다
    const syncDelBtn = () => {
        const btn = root.querySelector('#btn-del-picked');
        if (btn) btn.disabled = !pickedIds(root).length;
    };
    tbl.querySelector('#chk-all')?.addEventListener('change', (e) => {
        tbl.querySelectorAll('input[data-pick]')
            .forEach((el) => { el.checked = e.target.checked; });
        syncDelBtn();
    });
    tbl.querySelectorAll('input[data-pick]')
        .forEach((el) => el.addEventListener('change', syncDelBtn));
    syncDelBtn();
    tbl.querySelectorAll('[data-packing]').forEach((el) => {
        el.addEventListener('click', () => {
            const o = groups.flatMap((g) => g.rows).find((x) => x.id === el.dataset.packing);
            if (o) openPackingNoteModal(o, user, reload);
        });
    });
}

/**
 * 행 선택 체크박스 - 삭제할 수 있는 행에만 붙는다.
 * 묶음 행은 살아 있는 멤버 전부를 한 번에 고른다 (value 에 id 목록).
 * 상차완료된 주문이 섞여 있으면 고를 수 없다 (서버도 거부한다).
 */
function pickBox(list, user) {
    const live = list.filter((r) => !r.canceled_at);
    const targets = live.length ? live : list;
    if (targets.some((r) => loadDone(r))) {
        return '<span class="muted" title="상차완료된 주문은 삭제할 수 없습니다">-</span>';
    }
    // 본인 등록건만 보는 사용자는 자기 것만 지울 수 있다 (RLS 와 같은 규칙)
    if (!can(user, 'viewAll') && targets.some((r) => r.created_by !== user.id)) {
        return '<span class="muted">-</span>';
    }
    return `<input type="checkbox" data-pick="${targets.map((r) => r.id).join(',')}">`;
}

/** 표에서 체크된 주문 id 목록 (묶음은 멤버로 풀린다) */
function pickedIds(root) {
    return [...root.querySelectorAll('input[data-pick]:checked')]
        .flatMap((el) => el.dataset.pick.split(','));
}

/**
 * 항목별 수정 내역 HTML.
 * 가장 오래된 변경부터 순서대로 이전 → 이후 값을 보여준다.
 * @param {Array} logs 해당 항목의 이력 (오래된 순)
 */
function changeLog(logs) {
    const first = logs[0].before;
    return `
<div class="change-log">
  <div class="change-log__origin">
    <span class="change-log__tag">최초 내용</span>
    <b>${esc(first) || '<i class="muted">(없음)</i>'}</b>
  </div>
  ${logs.map((h) => `
  <div class="change-log__line">
    <span class="change-log__rev">${h.rev}회차</span>
    <span class="change-log__from">${esc(h.before) || '<i class="muted">(없음)</i>'}</span>
    <span class="change-log__arrow">→</span>
    <span class="change-log__to">${esc(h.after) || '<i class="muted">(없음)</i>'}</span>
    <span class="change-log__meta">
      ${fmtDateTime(h.changed_at)} · ${esc(h.changed_by_name)}${h.memo ? ` · ${esc(h.memo)}` : ''}
    </span>
  </div>`).join('')}
</div>`;
}

/** 상세 팝업의 탭 정의 */
const DETAIL_TABS = [
    { key: 'info', label: '주문정보상세' },
    { key: 'adjust', label: '조정요청' },
    { key: 'history', label: '수정이력' },
];

/**
 * 주문 상세 팝업.
 * 주문정보상세 / 조정요청 / 수정이력 세 탭으로 나뉜다.
 *  - 조정요청 : 이 탭에서 등록하고, 용마담당자가 확인처리한다
 *  - 수정이력 : 실제 수정 내용만 보여주고, 용마담당자가 확인처리한다
 */
async function showDetail(id, user, reload) {
    const canConfirmHere = canConfirm(user);
    let activeTab = 'info';
    // 묶인 주문 중 지금 보고 있는 1건. 기본값은 묶음 대표다
    let pickedId = id;

    const m = openModal('주문 상세', `
<div class="tabs" id="d-tabs">
  ${DETAIL_TABS.map((t) => `
  <button class="tabs__btn ${t.key === 'info' ? 'is-active' : ''}"
          data-dtab="${t.key}" type="button">${t.label}</button>`).join('')}
</div>
<div id="d-pane"><div class="empty">불러오는 중...</div></div>`, { wide: true, xl: true });

    const pane = m.root.querySelector('#d-pane');

    /** 현재 탭을 다시 그린다 (데이터도 새로 읽는다) */
    async function draw() {
        const base = await db.getOrder(id);
        if (!base) return;
        // 🔑 묶인 주문번호 표에는 **취소된 멤버까지** 보여준다 (목록 배지에서는 빠진다).
        //    처리(접수·접수취소)는 취소되지 않은 멤버에만 적용된다
        const g = await db.getBatchGroup(id, true);
        const list = g && g.rows.length ? g.rows : [base];
        const live = list.filter((r) => !r.canceled_at);
        if (!list.some((r) => r.id === pickedId)) pickedId = list[0].id;
        const o = list.find((r) => r.id === pickedId) ?? base;

        m.root.querySelector('.modal__head h3').textContent = base.rep_no
            ? `주문 상세 - ${base.rep_no} (묶음 ${live.length}건)`
            : `주문 상세 - ${o.order_no} (${o.seq}차수)`;

        m.root.querySelectorAll('[data-dtab]').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.dtab === activeTab);
        });

        const pick = (nextId) => {
            pickedId = nextId;
            draw();
        };
        if (activeTab === 'info') await drawInfoPane(pane, o, list, pick);
        else if (activeTab === 'adjust') await drawAdjustPane(pane, o, user, canConfirmHere, draw);
        else await drawHistoryPane(pane, o, user, canConfirmHere, draw);

        drawFooter(o, live);
    }

    /**
     * 하단 버튼 - 탭마다 다르다.
     *   주문정보상세 : 수정
     *   조정요청     : 저장 (등록 폼 제출)
     *   수정이력     : 저장할 내용 없음
     * 주문 취소는 조정요청의 '전체취소' 항목으로 처리한다.
     * (닫기 버튼과 헷갈리지 않도록 하단에 취소 버튼을 두지 않는다)
     */
    function drawFooter(o, list = [o]) {
        const foot = m.root.querySelector('.modal__foot');
        // 접수·접수취소는 취소되지 않은 멤버에만 적용된다 (list 는 이미 걸러서 넘어온다)
        const head = list[0] ?? o;
        const waiting = list.filter((r) => !r.confirmed_at);
        const started = list.some((r) => r.ship_started_at || r.ship_done_at);
        const note = o.canceled_at
            ? `취소된 주문입니다. (${fmtDateTime(o.canceled_at)}${
                o.canceled_by_name ? ` · ${o.canceled_by_name}` : ''})${
                canEdit(user, o) ? ' 수정 버튼으로 내용을 고치거나 삭제할 수 있습니다.' : ''}`
            : loadDone(o) ? '상차완료된 주문이라 수정할 수 없습니다.' : '';

        // 조정요청 탭의 저장 버튼은 등록 카드 안에 있다 (목록 아래가 아니라 입력 바로 밑)
        const btns = [];
        if (activeTab === 'info' && canEdit(user, o)) {
            btns.push('<button class="btn btn--primary" id="btn-detail-edit" type="button">'
                + '수정</button>');
        }
        // 접수는 여기서만 한다 - 작업지시를 작성해야 접수되고, 확인 컬럼이 '접수' 로 바뀐다
        // 🔑 접수·접수취소는 묶음 전체에 적용된다
        if (activeTab === 'info' && canConfirmHere && !o.canceled_at) {
            if (waiting.length) {
                btns.push('<button class="btn btn--success" id="btn-accept-order" type="button">'
                    + '접수 (작업지시 작성)</button>');
            } else if (!started) {
                btns.push('<button class="btn" id="btn-revoke-confirm" type="button">'
                    + '접수취소</button>');
            }
        }

        foot.innerHTML = `
<div class="modal__foot-note">${esc(note)}</div>
${btns.length ? `<div class="btn-row">${btns.join('')}</div>` : ''}`;

        foot.querySelector('#btn-detail-edit')?.addEventListener('click', () => {
            m.close();
            openForm(o, user, reload);
        });

        // 접수 - 작업지시 입력칸을 하단에 펼친다. 작성해야 접수가 완료된다
        foot.querySelector('#btn-accept-order')?.addEventListener('click', () => {
            foot.innerHTML = `
<div class="accept-box">
  <span class="field__label">작업지시 * (현장에 전달할 내용을 작성하세요 -
    출고주문처리의 출고작업·검수작업 탭에 표시됩니다)</span>
  <textarea id="work-note" rows="3"
            placeholder="예: 파렛트 2단 적재, 라벨 부착 후 검수 진행">${esc(head.work_note)}</textarea>
  ${list.length > 1 ? `
  <p class="form-note">묶인 주문 ${list.length}건(미접수 ${waiting.length}건)에 같은 작업지시로
  한 번에 접수됩니다.</p>` : ''}
  <div class="btn-row">
    <button class="btn" id="btn-accept-cancel" type="button">취소</button>
    <button class="btn btn--success" id="btn-accept-save" type="button">접수완료</button>
  </div>
</div>`;
            foot.querySelector('#btn-accept-cancel')
                .addEventListener('click', () => drawFooter(o, list));
            foot.querySelector('#btn-accept-save').addEventListener('click', async () => {
                try {
                    const note = foot.querySelector('#work-note').value;
                    await db.confirmOrderGroup(head.id, note, user);
                    toast(`${waiting.length}건이 접수 처리되었습니다.`, 'success');
                    draw();
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
        });

        foot.querySelector('#btn-revoke-confirm')?.addEventListener('click', async () => {
            const msg = list.length > 1
                ? `묶인 주문 ${list.length}건의 접수를 모두 취소하시겠습니까?`
                : '접수를 취소하시겠습니까? 상태가 대기로 돌아갑니다.';
            if (!await confirmDialog(msg)) return;
            try {
                await db.revokeOrderConfirmGroup(head.id, user);
                toast('접수를 취소했습니다.', 'info');
                draw();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    }

    // 하단 영역을 미리 만들어 둔다 (openModal 은 footer 문자열을 받아 생성한다)
    if (!m.root.querySelector('.modal__foot')) {
        const foot = document.createElement('div');
        foot.className = 'modal__foot';
        m.root.querySelector('.modal').appendChild(foot);
    }

    m.root.querySelectorAll('[data-dtab]').forEach((el) => {
        el.addEventListener('click', () => {
            activeTab = el.dataset.dtab;
            draw();
        });
    });

    await draw();
    // 팝업에서 처리한 내용이 목록에 반영되도록 닫을 때 갱신한다
    m.root.querySelector('.modal__close').addEventListener('click', reload);
}

/* ------------------------------ 탭 1. 주문정보상세 ----------------------------- */

/**
 * 묶인 주문번호 표 - 대표주문번호로 묶인 주문을 모두 보여준다.
 * 🔑 **취소된 멤버까지** 보여준다 (처리 대상은 아니지만 묶음에 있던 사실은 남는다).
 * 행을 누르면 아래 상세·조정요청·수정이력이 그 주문 기준으로 바뀐다.
 */
function groupTableHtml(list, pickedId) {
    const canceled = list.filter((r) => r.canceled_at).length;
    return `
<div class="hist-sec" style="margin-bottom:14px">
  <h4>묶인 주문번호 <span class="tag tag--gray">${list.length - canceled}건</span>${
    canceled ? ` <span class="tag tag--red tag--canceled">취소 ${canceled}건</span>` : ''}</h4>
  <table class="grid"><thead><tr>
    <th>주문번호</th><th class="center">차수</th><th>거래처명</th>
    <th>출고요청일</th><th class="center">출고형태</th><th class="center">상태</th>
  </tr></thead>
  <tbody>
  ${list.map((r) => `
  <tr class="is-clickable ${r.id === pickedId ? 'is-picked' : ''} ${
    r.canceled_at ? 'is-canceled' : ''}" data-pick-order="${r.id}">
    <td><span class="link">${esc(r.order_no)}</span></td>
    <td class="center">${seqTag(r.seq)}</td>
    <td>${esc(r.customer)}</td>
    <td>${r.ship_req_date || '미정'}</td>
    <td class="center">${esc(r.vehicle_type)}</td>
    <td class="center">${stateCell(r)}</td>
  </tr>`).join('')}
  </tbody></table>
  <p class="form-note">행을 누르면 아래 상세·조정요청·수정이력이 그 주문 기준으로 바뀝니다.</p>
</div>`;
}

/**
 * 주문정보상세 탭.
 * @param {object} o 지금 보고 있는 주문 1건
 * @param {object[]} list 묶인 주문 전체 (대표가 맨 앞)
 * @param {(id:string) => void} pick 다른 주문을 고를 때
 */
async function drawInfoPane(pane, o, list = [o], pick = null) {
    const id = o.id;
    const [owner, tasks, adjust, history] = await Promise.all([
        db.getUser(o.created_by), db.extraTaskMap(), db.adjustMap(), db.listHistory(id),
    ]);
    const stepOpt = { task: Boolean(tasks[o.order_no]), adjust: adjust[o.id] };

    // 항목별 수정 이력 (오래된 순)
    const editLog = {};
    history.filter((h) => h.rev > 0).forEach((h) => {
        (editLog[h.field] ??= []).unshift(h);
    });

    /** 항목 1칸. 수정된 적이 있으면 눌러서 이전 내용을 펼쳐 볼 수 있다 */
    const row = (k, v, full = false) => {
        const logs = editLog[k];
        const cls = `detail-item ${full ? 'detail-item--full' : ''} ${logs ? 'is-edited' : ''}`;
        const attr = logs
            ? `data-field="${esc(k)}" role="button" tabindex="0" title="눌러서 이전 내용 보기"` : '';
        return `
<div class="${cls}" ${attr}>
  <div class="detail-item__row">
    <span class="detail-item__label">
      ${k}${logs ? '<span class="tag tag--amber">수정됨</span>' : ''}
    </span>
    <span class="detail-item__value">${esc(v) || '<i class="muted">-</i>'}</span>
    ${logs ? '<span class="detail-item__caret" aria-hidden="true">▾</span>' : ''}
  </div>
  ${logs ? `<div class="detail-item__log" hidden>${changeLog(logs)}</div>` : ''}
</div>`;
    };

    pane.innerHTML = `
${list.length > 1 ? groupTableHtml(list, o.id) : ''}
<div class="detail-grid">
${o.rep_no ? row('대표주문번호', o.rep_no) : ''}
${row('주문번호', o.order_no)}
${row('거래처명', o.customer)}
${row('담당자', owner?.name ?? '-')}
${row('차수', `${o.seq}차수`)}
${row('출고형태', o.vehicle_type)}
${row('등록일자', o.reg_date)}
${row('전송일자', o.send_date)}
${row('출고요청일', o.ship_req_date || '미정')}
${row('팀명', o.team_name)}
${row('접수확인', o.confirmed_at
        ? `접수확인 · ${fmtDateTime(o.confirmed_at)}${o.confirmed_by_name ? ` · ${o.confirmed_by_name}` : ''}`
        : '미확인')}
${row('품목수', `${num(o.item_count)}개`)}
${row('출고수량', `${num(o.qty)}ea`)}
${row('파렛트수', `${num(o.pallet_count)}파렛트`)}
${row('처리현황', currentStep(o, stepOpt))}
${row('상태', stateOf(o))}
${row('추가작업', o.extra_yn === YN.YES && (o.extra_works ?? []).length
        ? `${YN.YES} (${o.extra_works.join(', ')})` : o.extra_yn)}
${row('패킹리스트', o.packing_yn)}
${row('패킹리스트 내용', o.packing_note, true)}
${row('작업지시', o.work_note, true)}
${row('요청사항', o.request_note, true)}
${row('비고', o.remark, true)}
</div>`;

    pane.querySelectorAll('[data-pick-order]').forEach((el) => {
        el.addEventListener('click', () => pick?.(el.dataset.pickOrder));
    });

    pane.querySelectorAll('[data-field]').forEach((el) => {
        const toggle = () => {
            const log = el.querySelector('.detail-item__log');
            log.hidden = !log.hidden;
            el.classList.toggle('is-open', !log.hidden);
        };
        el.addEventListener('click', toggle);
        el.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            toggle();
        });
    });
}

/**
 * 확인 조작 영역 (변동 이력 · 조정요청 공통).
 * @param {object} row  checked_at 을 가진 행
 * @param {boolean} canCheck 조작 권한
 * @param {string} attr 버튼에 붙일 데이터 속성명
 * @param {string} label 미처리 상태의 버튼 문구
 * @param {string} doneLabel 처리 완료 상태의 문구
 */
function checkControl(row, canCheck, attr, label, doneLabel = '확인완료') {
    if (row.checked_at) {
        const by = row.checked_by_name ? ` · ${row.checked_by_name}` : '';
        const tip = `${fmtDateTime(row.checked_at)}${by}`;
        return canCheck
            ? `<button class="btn btn--sm btn--confirmed" ${attr}="${row.id}" type="button"
                 title="${esc(tip)} (누르면 해제)">${doneLabel}</button>`
            : `<span class="tag tag--green" title="${esc(tip)}">${doneLabel}</span>`;
    }
    return canCheck
        ? `<button class="btn btn--sm" ${attr}="${row.id}" type="button">${label}</button>`
        : '<span class="tag tag--gray">미확인</span>';
}

/** 확인처리 기록 한 줄 - 누가 언제 확인했는지 남긴다 */
function checkedMeta(row) {
    if (!row.checked_at) return '';
    const who = row.checked_by_name || '-';
    return `<div class="history__checked">
        처리 <b>${esc(who)}</b> · ${fmtDateTime(row.checked_at)}</div>`;
}

/**
 * 주문 등록/수정 폼
 * @param {object|null} o 수정 대상 (null 이면 신규 등록)
 */
function openForm(o, user, reload) {
    const isEdit = Boolean(o);
    let baseNo = '';        // 추가주문으로 고른 묶음의 기준 번호 (등록 시 함께 넘긴다)
    const v = (k, d = '') => esc(o?.[k] ?? d);
    const m = openModal(isEdit ? `주문 수정 - ${o.order_no}` : '주문 등록', `
<p class="req-note"><span class="req">*</span> 표시는 필수 입력 항목입니다.</p>
<form id="order-form">
  ${isEdit ? '' : `
  <div class="checks" id="order-kind" style="margin-bottom:14px">
    <label class="check check--inline">
      <input type="radio" name="kind" value="new" checked> 신규주문
    </label>
    <label class="check check--inline">
      <input type="radio" name="kind" value="add"> 추가주문
    </label>
  </div>
  <p class="form-note" id="kind-note" style="margin:0 0 14px" hidden>
    기존 주문번호를 고르면 다음 차수로 등록됩니다. (종결된 주문번호는 나오지 않습니다)
  </p>`}
  <div class="form-grid">
    <label class="field">
      <span class="field__label">전송일자<span class="req">*</span></span>
      <input type="date" name="send_date" required value="${v('send_date', today())}">
    </label>
    <label class="field">
      <span class="field__label">대표주문번호</span>
      <input type="text" name="rep_no" placeholder="필요 시 입력 (예: R-2609-001)"
             autocomplete="off" list="open-rep-nos" value="${v('rep_no')}">
      <datalist id="open-rep-nos"></datalist>
      <span class="form-note">같은 거래처의 여러 주문을 한 검수·상차 단위로 묶을 때 적습니다.
        묶인 주문은 목록에 1건으로 보입니다.</span>
    </label>
    <label class="field">
      <span class="field__label">주문번호<span class="req">*</span></span>
      <input type="text" name="order_no" required placeholder="PO-00000000"
             autocomplete="off" list="${isEdit ? '' : 'open-order-nos'}" value="${v('order_no')}">
      ${isEdit ? '' : '<datalist id="open-order-nos"></datalist>'}
      <span class="field__label" id="order-no-hint"></span>
    </label>
    <label class="field">
      <span class="field__label">거래처명<span class="req">*</span></span>
      <input type="text" name="customer" required value="${v('customer')}">
    </label>
    <label class="field">
      <span class="field__label">출고요청일<span class="req">*</span></span>
      <input type="date" name="ship_req_date" ${isEdit && !o?.ship_req_date ? 'disabled' : 'required'}
             value="${v('ship_req_date', isEdit ? '' : today())}">
      <label class="check check--inline">
        <input type="checkbox" name="ship_req_undecided"
               ${isEdit && !o?.ship_req_date ? 'checked' : ''}> 미정 (일자 미지정)
      </label>
    </label>
    <div class="field">
      <span class="field__label">출고형태<span class="req">*</span></span>
      <div class="checks">
        ${VEHICLE_TYPES.map((t) => `
        <label class="check check--inline">
          <input type="radio" name="vehicle_type" value="${t}"
                 ${(o?.vehicle_type ?? VEHICLE_TYPES[0]) === t ? 'checked' : ''} required> ${t}
        </label>`).join('')}
      </div>
    </div>
    <label class="field">
      <span class="field__label">팀명</span>
      <input type="text" name="team_name" value="${v('team_name')}">
    </label>
    <div class="field">
      <span class="field__label">추가작업<span class="req">*</span></span>
      <div class="checks">
        ${YN_LIST.map((y) => `
        <label class="check check--inline">
          <input type="radio" name="extra_yn" value="${y}"
                 ${(o?.extra_yn ?? YN.NO) === y ? 'checked' : ''} required> ${y}
        </label>`).join('')}
      </div>
    </div>
    <div class="field">
      <span class="field__label">패킹리스트<span class="req">*</span></span>
      <div class="checks">
        ${YN_LIST.map((y) => `
        <label class="check check--inline">
          <input type="radio" name="packing_yn" value="${y}"
                 ${(o?.packing_yn ?? YN.NO) === y ? 'checked' : ''} required> ${y}
        </label>`).join('')}
      </div>
    </div>
    <label class="field full">
      <span class="field__label">요청사항</span>
      <textarea name="request_note">${v('request_note')}</textarea>
    </label>
    <label class="field full">
      <span class="field__label">비고</span>
      <input type="text" name="remark" value="${v('remark')}">
    </label>
    ${isEdit ? `
    <label class="field full">
      <span class="field__label">변경 사유 (히스토리에 기록됩니다)</span>
      <input type="text" name="memo" placeholder="예: 거래처 요청으로 출고일 변경">
    </label>` : ''}
  </div>
  <div class="form-actions">
    ${isEdit ? '<button class="btn btn--danger" id="btn-del" type="button">삭제</button>' : ''}
    <button class="btn" type="button" id="btn-cancel">취소</button>
    <button class="btn btn--primary" type="submit">${isEdit ? '수정 저장' : '등록'}</button>
  </div>
</form>`, { wide: true });

    m.body.querySelector('#btn-cancel').addEventListener('click', m.close);

    // 열려 있는(완료처리·취소 전) 대표주문번호를 제안한다
    db.listOpenRepNos({ createdBy: user.id })   // 같은 등록자의 묶음만 붙일 수 있다
        .then((reps) => {
            const list = m.body.querySelector('#open-rep-nos');
            if (!list) return;
            list.innerHTML = reps.map((r) => `
<option value="${esc(r.rep_no)}">${esc(r.customer)} · 묶인 주문 ${r.count}건</option>`).join('');
        })
        .catch((err) => toast(err.message, 'error'));

    // 출고요청일 '미정' - 체크하면 일자 입력을 비활성화하고 빈 값(미정)으로 저장한다
    const shipDateInput = m.body.querySelector('[name="ship_req_date"]');
    const undecidedChk = m.body.querySelector('[name="ship_req_undecided"]');
    undecidedChk.addEventListener('change', () => {
        shipDateInput.disabled = undecidedChk.checked;
        shipDateInput.required = !undecidedChk.checked;
        if (undecidedChk.checked) shipDateInput.value = '';
    });

    // 신규/추가 선택 - 추가주문이면 기존 주문번호를 고르고, 그 정보를 채워 준다
    if (!isEdit) {
        const kindBox = m.body.querySelector('#order-kind');
        const note = m.body.querySelector('#kind-note');
        const noInput = m.body.querySelector('[name="order_no"]');
        const hint = m.body.querySelector('#order-no-hint');
        const list = m.body.querySelector('#open-order-nos');
        let opens = [];

        /** 고른 주문번호가 실제 대상인지 확인하고 안내를 갱신한다 */
        const syncHint = () => {
            const add = kindBox.querySelector('[name="kind"]:checked').value === 'add';
            if (!add) {
                hint.textContent = '';
                return;
            }
            const val = noInput.value.trim();
            // 목록에서 고른 경우: 기준 번호(a11111) 또는 제안 번호(a11111-1)
            const picked = opens.find((x) => x.base_no === val || x.next_no === val);
            if (picked) {
                baseNo = picked.base_no;
                // 기준 번호를 골랐으면 다음 연번을 붙여 준다 (a11111 → a11111-1)
                if (val === picked.base_no) noInput.value = picked.next_no;
                const cust = m.body.querySelector('[name="customer"]');
                if (!cust.value) cust.value = picked.customer;
            } else if (val && baseNo && !val.startsWith(baseNo)) {
                // 기준 번호와 아예 다른 값을 넣으면 선택을 푼다
                baseNo = '';
            }
            // ⚠️ 연번은 차수와 무관하게 붙을 수 있다(a11111-3 등).
            //    번호를 직접 고쳐도 한 번 고른 기준 번호는 유지한다.
            const base = opens.find((x) => x.base_no === baseNo);
            hint.textContent = base
                ? `${base.customer} · ${base.base_no} 묶음 · 현재 ${base.seq}차수 `
                  + `→ ${base.seq + 1}차수로 등록`
                : '목록에 있는 기존 주문번호를 고르세요.';
            hint.style.color = base ? 'var(--green)' : 'var(--red)';
        };

        kindBox.addEventListener('change', async () => {
            const add = kindBox.querySelector('[name="kind"]:checked').value === 'add';
            note.hidden = !add;
            noInput.placeholder = add ? '기존 주문번호 선택' : 'PO-00000000';
            if (add && !opens.length) {
                opens = await db.listOpenOrderNos({
                    createdBy: can(user, 'viewAll') ? undefined : user.id,
                });
                list.innerHTML = opens.map((x) => `
<option value="${esc(x.base_no)}">${esc(x.customer)} · 현재 ${x.seq}차수 → ${esc(x.next_no)}</option>`)
                    .join('');
            }
            syncHint();
        });

        noInput.addEventListener('input', syncHint);
    }

    m.body.querySelector('#btn-del')?.addEventListener('click', async () => {
        if (!await confirmDialog('해당 주문을 삭제하시겠습니까?')) return;
        await db.deleteOrder(o.id, user);
        m.close();
        toast('삭제되었습니다.', 'success');
        reload();
    });

    m.body.querySelector('#order-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = new FormData(e.target);
        const fd = Object.fromEntries(form);
        // 미정이면 출고요청일을 빈 값으로 저장한다 (비활성화된 입력은 FormData 에 없다)
        fd.ship_req_date = undecidedChk.checked ? '' : fd.ship_req_date;
        delete fd.ship_req_undecided;
        const memo = fd.memo ?? '';
        delete fd.memo;
        // 추가주문이면 차수를 올려 등록한다 (kind 는 저장 필드가 아니다)
        const addition = fd.kind === 'add';
        delete fd.kind;
        try {
            if (isEdit) {
                await db.updateOrder(o.id, fd, user, memo);
                toast('수정되었습니다.', 'success');
            } else {
                const created = await db.createOrder(
                    { ...fd, addition, base_no: addition ? baseNo : undefined }, user,
                );
                toast(`${created.seq}차수로 등록되었습니다.`, 'success');
            }
            m.close();
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

/* ------------------------------- 탭 2. 조정요청 ------------------------------ */

/**
 * 조정요청 탭.
 * 이 탭에서 조정요청을 등록하고, 등록된 요청을 용마담당자가 확인처리한다.
 */
async function drawAdjustPane(pane, o, user, canCheck, redraw) {
    const list = await db.listRestores(o.id);
    const canAdd = canRestore(user, o);
    const left = list.filter((r) => !r.checked_at).length;

    pane.innerHTML = `
${canAdd ? `
<div class="card" style="margin-bottom:16px">
  <div class="card__head"><h2>조정요청 등록</h2></div>
  <div class="card__body">
    ${restoreFormHtml(o)}
    <div class="form-actions">
      <button class="btn btn--primary" id="btn-adjust-save" type="button">저장</button>
    </div>
  </div>
</div>` : `
<p class="form-note" style="margin:0 0 16px">
  ${o.canceled_at ? '취소된 주문이라 조정요청을 등록할 수 없습니다.'
        : o.inspect_done_at ? '검수작업이 완료되어 조정요청을 등록할 수 없습니다.'
            : '조정요청 등록 권한이 없습니다.'}
</p>`}

<div class="hist-sec">
  <h4>등록된 조정요청 <span class="tag tag--gray">${list.length}건</span>
    ${list.length ? (left
        ? `<span class="tag tag--red">미접수 ${left}건</span>`
        : '<span class="tag tag--green">모두 접수</span>') : ''}
  </h4>
  ${list.length ? `<ul class="history">${list.map((r) => `
<li class="history__item">
  <div class="history__main">
    <div class="history__diff">
      <span class="tag tag--amber">${adjustCategory(r.category).label}</span>
      <span class="tag ${r.type === RESTORE_TYPE.EMAIL ? 'tag--blue' : 'tag--green'}">
        ${RESTORE_TYPE_LABEL[r.type]}
      </span>
      <b>${esc(r.reason)}</b>${r.product_code || r.qty
    ? ` · 제품코드 ${esc(r.product_code || '-')} / 수량 ${esc(r.qty || '-')}` : ''}
    </div>
    <div class="history__meta">
      ${fmtDateTime(r.created_at)} · ${esc(r.created_by_name ?? '')}
    </div>
    ${checkedMeta(r)}
  </div>
  <div class="history__action">
    ${checkControl(r, canCheck, 'data-check-restore', '접수', '접수완료')}
  </div>
</li>`).join('')}</ul>` : '<div class="empty">등록된 조정요청이 없습니다.</div>'}
</div>`;

    if (canAdd) {
        bindRestoreForm(pane, o, user, redraw);
        pane.querySelector('#btn-adjust-save').addEventListener('click', () => {
            pane.querySelector('#restore-form').requestSubmit();
        });
    }
    // 접수하면 출고주문처리의 조정요청 탭에 자동으로 등록된다
    pane.querySelectorAll('[data-check-restore]').forEach((el) => {
        el.addEventListener('click', async () => {
            try {
                const row = await db.toggleRestoreCheck(el.dataset.checkRestore, user);
                toast(row.checked_at
                    ? '접수되었습니다. 출고주문처리 > 조정요청 탭에 등록되었습니다.'
                    : '접수를 해제했습니다. 조정요청 탭에서 제외됩니다.',
                row.checked_at ? 'success' : 'info');
                redraw();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/* ------------------------------- 탭 3. 수정이력 ------------------------------ */

/**
 * 수정이력 탭.
 * 실제 수정(rev > 0)만 보여준다. 등록·처리현황·접수확인 같은 이벤트는 제외한다.
 * 용마담당자가 건별로 확인처리한다.
 */
async function drawHistoryPane(pane, o, user, canCheck, redraw) {
    const all = await db.listHistory(o.id);
    const list = all.filter((h) => h.rev > 0);
    const left = list.filter((h) => !h.checked_at).length;

    pane.innerHTML = `
<div class="hist-sec">
  <h4>수정 내용 <span class="tag tag--gray">${list.length}건</span>
    ${o.edit_count ? `<span class="tag tag--amber">수정 ${o.edit_count}회</span>` : ''}
    ${list.length ? (left
        ? `<span class="tag tag--red">미확인 ${left}건</span>`
        : '<span class="tag tag--green">모두 확인</span>') : ''}
  </h4>
  ${list.length ? `<ul class="history">${list.map((h) => `
<li class="history__item">
  <div class="history__main">
    <div class="history__diff"><b>${esc(h.field)}</b></div>
    <div class="diff">
      <span class="diff__box diff__box--before">
        <span class="diff__label">이전</span>${esc(h.before) || '<i>(없음)</i>'}
      </span>
      <span class="diff__arrow">→</span>
      <span class="diff__box diff__box--after">
        <span class="diff__label">이후</span>${esc(h.after) || '<i>(없음)</i>'}
      </span>
    </div>
    ${h.memo ? `<div class="history__diff">사유: ${esc(h.memo)}</div>` : ''}
    <div class="history__meta">
      ${fmtDateTime(h.changed_at)} · ${esc(h.changed_by_name)} · ${h.rev}회차 수정
    </div>
    ${checkedMeta(h)}
  </div>
  <div class="history__action">
    ${checkControl(h, canCheck, 'data-check', '수정확인')}
  </div>
</li>`).join('')}</ul>` : '<div class="empty">수정된 내용이 없습니다.</div>'}
</div>`;

    bindCheckToggle(pane, '[data-check]', db.toggleHistoryCheck, '수정확인', user, redraw);
}

/** 확인 토글 버튼 바인딩 (수정이력 · 조정요청 공통) */
function bindCheckToggle(scope, selector, toggle, name, user, redraw) {
    scope.querySelectorAll(selector).forEach((el) => {
        el.addEventListener('click', async () => {
            try {
                const id = el.dataset.check ?? el.dataset.checkRestore;
                const row = await toggle(id, user);
                toast(row.checked_at ? `${name} 처리되었습니다.` : `${name}을 해제했습니다.`,
                    row.checked_at ? 'success' : 'info');
                redraw();
            } catch (err) {
                toast(err.message, 'error');
            }
        });
    });
}

/* ---------------------------- 조정요청 등록 폼 ---------------------------- */

/**
 * 조정요청 등록 폼 HTML.
 * 작성 방식이 두 가지다.
 *  - 이메일로 발송 : 조정사유만 선택하고 별도 작성 내용은 없다
 *  - 여기에 작성   : 주문번호·거래처명·제품코드·수량·조정사유를 직접 작성한다
 */
function restoreFormHtml(o) {
    return `
<p class="req-note"><span class="req">*</span> 표시는 필수 입력 항목입니다.</p>
<form id="restore-form">
  <div class="field full" style="margin-bottom:14px">
    <span class="field__label">요청항목<span class="req">*</span></span>
    <div class="checks">
      ${ADJUST_CATEGORIES.map((c, i) => `
      <label class="check check--inline">
        <input type="radio" name="category" value="${c.key}" ${i === 0 ? '' : ''}
               ${c.key === 'etc' ? 'checked' : ''}>
        ${c.label}
      </label>`).join('')}
    </div>
    <p class="form-note" id="cat-desc"></p>
  </div>

  <div class="field full" style="margin-bottom:14px">
    <span class="field__label">작성 방식<span class="req">*</span></span>
    <div class="checks">
      <label class="check check--inline">
        <input type="radio" name="type" value="${RESTORE_TYPE.EMAIL}" checked>
        ${RESTORE_TYPE_LABEL[RESTORE_TYPE.EMAIL]}
      </label>
      <label class="check check--inline">
        <input type="radio" name="type" value="${RESTORE_TYPE.FORM}">
        ${RESTORE_TYPE_LABEL[RESTORE_TYPE.FORM]}
      </label>
    </div>
  </div>

  <div id="pane-email">
    <label class="field full">
      <span class="field__label">조정사유<span class="req">*</span></span>
      <select name="reason_select" required>
        ${RESTORE_REASONS.map((r) => `<option value="${r}">${r}</option>`).join('')}
      </select>
    </label>
    <p class="form-note">
      선택한 사유로 담당자에게 메일이 발송됩니다. 별도로 작성할 내용은 없습니다.
    </p>
  </div>

  <div id="pane-form" hidden>
    <div class="form-grid">
      <label class="field">
        <span class="field__label">주문번호<span class="req">*</span></span>
        <input type="text" name="order_no" value="${esc(o.order_no)}" disabled>
      </label>
      <label class="field">
        <span class="field__label">거래처명<span class="req">*</span></span>
        <input type="text" name="customer" value="${esc(o.customer)}" disabled>
      </label>
      <label class="field">
        <span class="field__label">제품코드<span class="req">*</span></span>
        <input type="text" name="product_code" placeholder="예: A-102" disabled>
      </label>
      <label class="field">
        <span class="field__label">수량<span class="req">*</span></span>
        <input type="number" name="qty" min="1" placeholder="예: 300" disabled>
      </label>
      <label class="field full">
        <span class="field__label">조정사유<span class="req">*</span></span>
        <textarea name="reason_text" placeholder="조정이 필요한 사유를 작성하세요." disabled></textarea>
      </label>
    </div>
  </div>

</form>`;
}

/** 조정요청 등록 폼 동작 */
function bindRestoreForm(pane, o, user, redraw) {
    const paneEmail = pane.querySelector('#pane-email');
    const paneForm = pane.querySelector('#pane-form');

    /**
     * 선택한 방식의 입력란만 활성화한다.
     * 숨긴 입력란은 disabled 로 둬야 필수값 검증과 전송 대상에서 빠진다.
     */
    function switchPane(type) {
        const isEmail = type === RESTORE_TYPE.EMAIL;
        paneEmail.hidden = !isEmail;
        paneForm.hidden = isEmail;
        paneEmail.querySelectorAll('select, input, textarea')
            .forEach((el) => { el.disabled = !isEmail; });
        paneForm.querySelectorAll('select, input, textarea')
            .forEach((el) => { el.disabled = isEmail; });
        paneForm.querySelectorAll('[name="order_no"], [name="customer"]')
            .forEach((el) => { el.readOnly = true; });
    }

    switchPane(RESTORE_TYPE.EMAIL);
    pane.querySelectorAll('[name="type"]').forEach((el) => {
        el.addEventListener('change', () => switchPane(el.value));
    });

    /** 선택한 요청항목의 설명을 보여준다 */
    const descBox = pane.querySelector('#cat-desc');
    function showDesc() {
        const key = pane.querySelector('[name="category"]:checked')?.value;
        const c = adjustCategory(key);
        descBox.innerHTML = c.cancelsOrder
            ? `⚠️ <b>${esc(c.desc)}</b>`
            : esc(c.desc);
        descBox.classList.toggle('is-warn', Boolean(c.cancelsOrder));
    }
    pane.querySelectorAll('[name="category"]').forEach((el) => {
        el.addEventListener('change', showDesc);
    });
    showDesc();

    pane.querySelector('#restore-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        const isEmail = fd.type === RESTORE_TYPE.EMAIL;
        const cat = adjustCategory(fd.category);

        // 전체취소는 주문 자체를 취소하므로 한 번 더 확인한다
        if (cat.cancelsOrder) {
            const msg = `[전체취소] 주문 ${o.order_no} (${o.seq}차수) 을(를) 취소합니다.\n`
                + '복구할 수 없으며 다시 주문을 등록해야 합니다. 진행하시겠습니까?';
            if (!await confirmDialog(msg)) return;
        }

        try {
            await db.createRestore({
                order_id: o.id,
                type: fd.type,
                category: fd.category,
                reason: isEmail ? fd.reason_select : fd.reason_text,
                order_no: isEmail ? o.order_no : fd.order_no,
                customer: isEmail ? o.customer : fd.customer,
                product_code: isEmail ? '' : fd.product_code,
                qty: isEmail ? '' : fd.qty,
            }, user);
            if (cat.cancelsOrder) {
                await db.cancelOrder(o.id, user, '전체취소 요청');
                toast('전체취소 요청이 등록되고 주문이 취소 처리되었습니다.', 'success');
            } else {
                toast(isEmail ? '조정요청이 등록되었습니다. (메일 발송 대상)'
                    : '조정요청이 등록되었습니다.', 'success');
            }
            redraw();
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

/* -------------------------------- 일괄등록 -------------------------------- */

/**
 * 일괄등록의 주문구분 값.
 * `기존` 은 등록 폼의 **추가주문**과 같다 - 기존 묶음의 다음 차수로 들어간다.
 */
const BULK_KIND = { NEW: '신규', ADD: '기존' };
const BULK_KINDS = [BULK_KIND.NEW, BULK_KIND.ADD];

/** 일괄등록 표의 컬럼 순서 (추가작업은 일괄등록에서 받지 않는다) */
const BULK_COLS = [
    {
        key: 'kind',
        label: '주문구분',
        required: true,
        narrow: true,
        hint: BULK_KINDS.join('/'),
    },
    { key: 'send_date', label: '전송일자', required: true, date: true, hint: '2026-08-30' },
    {
        key: 'ship_req_date',
        label: '출고요청일',
        required: true,
        date: true,
        allowUndecided: true,
        hint: '2026-08-31 또는 미정',
    },
    { key: 'customer', label: '거래처명', required: true, hint: '올리브영 물류센터' },
    { key: 'rep_no', label: '대표주문번호', hint: '필요 시' },
    { key: 'order_no', label: '주문번호', required: true, hint: 'PO-24080101' },
    { key: 'vehicle_type', label: '출고형태', required: true, hint: '용차/픽업/택배' },
    { key: 'team_name', label: '팀명', hint: '' },
    { key: 'request_note', label: '요청사항', hint: '' },
    { key: 'remark', label: '비고', hint: '' },
];

const BULK_MIN_ROWS = 5;

/** 붙여넣은 날짜 문자열을 YYYY-MM-DD 로 정규화한다 */
function normDate(v) {
    const t = String(v ?? '').trim();
    if (!t) return '';
    const m = t.match(/^(\d{4})[-./]?(\d{1,2})[-./]?(\d{1,2})$/);
    if (!m) return t;   // 형식이 다르면 그대로 두고 검증에서 걸러낸다
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** 일괄등록 팝업 */
function openBulkForm(user, reload) {
    // rows[행][열] 형태의 문자열 표
    let rows = Array.from({ length: BULK_MIN_ROWS }, () => BULK_COLS.map(() => ''));

    const m = openModal('주문 일괄등록', `
<div class="bulk-guide">
  <b>엑셀에서 복사한 데이터를 표에 그대로 붙여넣으세요.</b>
  <ol>
    <li>엑셀에서 <b>머리글을 뺀 데이터 영역만</b> 선택해 복사합니다. (Ctrl+C)</li>
    <li>아래 표의 <b>첫 칸을 클릭</b>하고 붙여넣습니다. (Ctrl+V)</li>
    <li>행 수는 붙여넣은 데이터에 맞춰 <b>자동으로 늘어납니다.</b></li>
  </ol>
  <ul class="bulk-rule">
    <li><span class="req">*</span> 표시는 필수 입력 항목입니다.</li>
    <li><b>날짜</b> — <code>2026-08-30</code> · <code>2026/8/30</code> · <code>20260830</code>
      모두 인식합니다.</li>
    <li><b>출고요청일</b> — 일자를 정하지 않았으면 <code>미정</code> 이라고 적습니다.</li>
    <li><b>주문구분</b> — <code>${BULK_KIND.NEW}</code> 또는 <code>${BULK_KIND.ADD}</code>.
      <b>${BULK_KIND.ADD}</b> 은 이미 등록된 주문의 <b>다음 차수</b>로 들어갑니다
      (주문번호 칸에 <b>기존 주문번호</b>를 적으면 <code>번호-1</code> 처럼 자동으로 붙습니다).</li>
    <li><b>출고형태</b> — ${VEHICLE_TYPES.join(' 또는 ')}</li>
    <li><b>대표주문번호</b> — 여러 주문번호를 <b>한 검수·상차 단위</b>로 묶을 때만 적습니다.
      같은 값을 적은 주문은 목록에 1건으로 보이고 함께 처리됩니다
      (같은 대표주문번호는 <b>거래처명이 같아야</b> 합니다).</li>
    <li><b>추가작업</b> — 일괄등록에서는 받지 않습니다. 등록 후 수정에서 지정하세요.</li>
  </ul>
</div>

<div class="toolbar" style="margin:14px 0 10px">
  <button class="btn" id="btn-tpl" type="button">양식 다운로드</button>
  <span class="field__label">양식은 컬럼 순서 참조용입니다</span>
  <button class="btn" id="btn-addrow" type="button">행 추가</button>
  <button class="btn" id="btn-clear" type="button">전체 지우기</button>
  <div class="toolbar__spacer"></div>
  <span class="field__label" id="bulk-count"></span>
</div>

<div class="table-wrap"><table class="grid bulk-grid" id="bulk-tbl"></table></div>
<div id="bulk-msg"></div>`, {
        wide: true,
        xl: true,
        footer: `
<div class="modal__foot-note" id="bulk-note"></div>
<div class="btn-row">
  <button class="btn btn--primary" id="btn-bulk-save" type="button">등록</button>
</div>`,
    });

    const tbl = m.root.querySelector('#bulk-tbl');
    const msg = m.root.querySelector('#bulk-msg');

    /** 입력된 행 수 (한 칸이라도 값이 있는 행) */
    const filled = () => rows.filter((r) => r.some((c) => String(c).trim())).length;

    function draw(focus) {
        tbl.innerHTML = `
<thead><tr>
  <th class="num">#</th>
  ${BULK_COLS.map((c) => `
  <th>${c.label}${c.required ? '<span class="req">*</span>' : ''}</th>`).join('')}
</tr></thead>
<tbody>
${rows.map((r, ri) => `
<tr>
  <td class="num">${ri + 1}</td>
  ${r.map((v, ci) => `
  <td><input type="text" class="${BULK_COLS[ci].narrow ? 'narrow' : ''}"
       data-r="${ri}" data-c="${ci}" value="${esc(v)}"
       placeholder="${esc(BULK_COLS[ci].hint)}"></td>`).join('')}
</tr>`).join('')}
</tbody>`;

        tbl.querySelectorAll('input').forEach((el) => {
            el.addEventListener('input', () => {
                rows[Number(el.dataset.r)][Number(el.dataset.c)] = el.value;
                m.root.querySelector('#bulk-count').textContent = `입력 ${filled()}건`;
            });
        });
        m.root.querySelector('#bulk-count').textContent = `입력 ${filled()}건`;
        if (focus) {
            tbl.querySelector(`[data-r="${focus.r}"][data-c="${focus.c}"]`)?.focus();
        }
    }

    /**
     * 엑셀처럼 키보드로 셀을 이동한다.
     *   Enter / Shift+Enter : 아래 / 위 (마지막 행에서 Enter 는 행을 늘려 이어서 입력)
     *   ↑ ↓                : 위 / 아래
     *   ← →                : 커서가 셀 끝에 닿아 있으면 옆 셀로
     *   Tab / Shift+Tab     : 기본 동작이 이미 오른쪽 / 왼쪽 이동이라 손대지 않는다
     */
    tbl.addEventListener('keydown', (e) => {
        const cell = e.target.closest('input[data-r]');
        if (!cell) return;
        const r = Number(cell.dataset.r);
        const c = Number(cell.dataset.c);
        const atStart = cell.selectionStart === 0 && cell.selectionEnd === 0;
        const atEnd = cell.selectionStart === cell.value.length
            && cell.selectionEnd === cell.value.length;

        let tr = null;
        let tc = null;
        if (e.key === 'Enter') { tr = e.shiftKey ? r - 1 : r + 1; tc = c; }
        else if (e.key === 'ArrowDown') { tr = r + 1; tc = c; }
        else if (e.key === 'ArrowUp') { tr = r - 1; tc = c; }
        else if (e.key === 'ArrowRight' && atEnd) { tr = r; tc = c + 1; }
        else if (e.key === 'ArrowLeft' && atStart) { tr = r; tc = c - 1; }
        if (tr === null || tr < 0 || tc < 0 || tc >= BULK_COLS.length) return;

        e.preventDefault();
        if (tr >= rows.length) {
            if (e.key !== 'Enter') return;   // 마지막 행 아래로는 Enter 로만 늘린다
            rows.push(BULK_COLS.map(() => ''));
            draw({ r: tr, c: tc });
            return;
        }
        const next = tbl.querySelector(`[data-r="${tr}"][data-c="${tc}"]`);
        next?.focus();
        next?.select();
    });

    /** 엑셀에서 복사한 표(TSV)를 붙여넣는다 */
    tbl.addEventListener('paste', (e) => {
        const cell = e.target.closest('input');
        if (!cell) return;
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (!text.includes('\t') && !text.includes('\n')) return;   // 단일 값은 기본 동작
        e.preventDefault();

        const startR = Number(cell.dataset.r);
        const startC = Number(cell.dataset.c);
        const lines = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n');

        // 붙여넣은 만큼 행을 자동으로 늘린다
        while (rows.length < startR + lines.length) rows.push(BULK_COLS.map(() => ''));

        lines.forEach((line, i) => {
            line.split('\t').forEach((val, j) => {
                const c = startC + j;
                if (c >= BULK_COLS.length) return;
                rows[startR + i][c] = BULK_COLS[c].date ? normDate(val) : val.trim();
            });
        });
        draw({ r: startR, c: startC });
        toast(`${lines.length}행을 붙여넣었습니다.`, 'success');
    });

    m.root.querySelector('#btn-tpl').addEventListener('click', () => {
        downloadCsv('주문일괄등록_양식.csv',
            BULK_COLS.map((c) => c.label + (c.required ? '(필수)' : '')),
            [BULK_COLS.map((c) => c.hint)]);
    });

    m.root.querySelector('#btn-addrow').addEventListener('click', () => {
        for (let i = 0; i < 5; i += 1) rows.push(BULK_COLS.map(() => ''));
        draw();
    });

    m.root.querySelector('#btn-clear').addEventListener('click', async () => {
        if (!await confirmDialog('입력한 내용을 모두 지우시겠습니까?')) return;
        rows = Array.from({ length: BULK_MIN_ROWS }, () => BULK_COLS.map(() => ''));
        msg.innerHTML = '';
        draw();
    });

    m.root.querySelector('#btn-bulk-save').addEventListener('click', async () => {
        const targets = [];
        const errors = [];

        // 주문구분이 '기존' 인 행이 붙을 기존 묶음 목록.
        // 기준 번호(a11111)와 제안 번호(a11111-1) 어느 쪽으로 적어도 찾을 수 있게 담는다
        const opens = await db.listOpenOrderNos({
            createdBy: can(user, 'viewAll') ? undefined : user.id,
        });
        const openMap = new Map();
        opens.forEach((x) => { openMap.set(x.base_no, x); openMap.set(x.next_no, x); });
        // 한 번에 같은 묶음을 여러 건 올릴 수 있으므로 배치 안에서 쓴 차수를 센다
        const usedSeq = new Map();
        // 대표주문번호 묶음은 거래처명이 같아야 한다 (이미 등록된 묶음 + 이번 파일)
        const openReps = new Map((await db.listOpenRepNos({
            createdBy: can(user, 'viewAll') ? undefined : user.id,
        })).map((x) => [x.rep_no, x]));
        const fileReps = new Map();

        rows.forEach((r, ri) => {
            if (!r.some((c) => String(c).trim())) return;   // 빈 행은 건너뛴다
            const o = {};
            BULK_COLS.forEach((c, ci) => {
                o[c.key] = c.date ? normDate(r[ci]) : String(r[ci] ?? '').trim();
            });

            const bad = [];
            BULK_COLS.filter((c) => c.required && !o[c.key]).forEach((c) => bad.push(`${c.label} 누락`));
            ['send_date', 'ship_req_date'].forEach((k) => {
                // 출고요청일은 '미정' 도 허용한다 (일자를 정하지 않고 등록하는 경우)
                if (k === 'ship_req_date' && o[k] === '미정') return;
                if (o[k] && !/^\d{4}-\d{2}-\d{2}$/.test(o[k])) bad.push(`${k === 'send_date' ? '전송일자' : '출고요청일'} 형식 오류`);
            });
            if (o.kind && !BULK_KINDS.includes(o.kind)) {
                bad.push(`주문구분은 ${BULK_KINDS.join('/')} 만 가능 (입력값 '${o.kind}')`);
            }
            if (o.vehicle_type && !VEHICLE_TYPES.includes(o.vehicle_type)) {
                bad.push(`출고형태는 ${VEHICLE_TYPES.join('/')} 만 가능`);
            }
            if (o.ship_req_date === '미정') o.ship_req_date = '';

            if (o.rep_no) {
                const before = fileReps.get(o.rep_no);
                if (before && before.customer !== o.customer) {
                    bad.push(`대표주문번호 '${o.rep_no}' 의 거래처명이 ${before.row}행과 다릅니다`);
                }
                const open = openReps.get(o.rep_no);
                if (open && open.created_by !== user.id) {
                    bad.push(`대표주문번호 '${o.rep_no}' 는 다른 담당자가 등록한 묶음입니다`);
                } else if (open && open.customer !== o.customer) {
                    bad.push(`대표주문번호 '${o.rep_no}' 는 이미 '${open.customer}' 묶음으로`
                        + ' 등록되어 있습니다');
                }
                if (!before) fileReps.set(o.rep_no, { row: ri + 1, customer: o.customer });
            }

            // '기존' 은 이미 등록된 묶음에 다음 차수로 붙는다. 대상이 없으면 등록할 수 없다
            const picked = o.kind === BULK_KIND.ADD ? openMap.get(o.order_no) : null;
            if (o.kind === BULK_KIND.ADD && o.order_no && !picked) {
                bad.push(`'${o.order_no}' 는 추가할 수 있는 기존 주문번호가 아닙니다`);
            }

            if (bad.length) {
                errors.push(`${ri + 1}행: ${bad.join(', ')}`);
                return;
            }
            if (picked) {
                // 기준 번호에 다음 차수를 붙인다 (a11111 → a11111-1 → a11111-2)
                const used = usedSeq.get(picked.base_no) ?? 0;
                o.addition = true;
                o.base_no = picked.base_no;
                o.order_no = `${picked.base_no}-${picked.seq + used}`;
                usedSeq.set(picked.base_no, used + 1);
            }
            delete o.kind;          // 주문구분은 저장 필드가 아니다
            targets.push(o);
        });

        if (!targets.length && !errors.length) {
            toast('등록할 내용이 없습니다.', 'error');
            return;
        }
        if (errors.length) {
            msg.innerHTML = `
<div class="bulk-err">
  <b>${errors.length}건의 오류가 있습니다. 수정 후 다시 등록하세요.</b>
  <ul>${errors.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
</div>`;
            msg.scrollIntoView({ block: 'nearest' });
            return;
        }

        // 기존 주문에 붙는 건은 차수가 올라가므로 확인 문구에 따로 알린다
        const addCnt = targets.filter((t) => t.addition).length;
        const ok = await confirmDialog(`${targets.length}건을 등록하시겠습니까?`
            + (addCnt ? `\n\n그중 ${addCnt}건은 기존 주문의 다음 차수로 등록됩니다.` : ''));
        if (!ok) return;
        try {
            for (const o of targets) await db.createOrder(o, user);
            m.close();
            toast(`${targets.length}건이 등록되었습니다.`, 'success');
            reload();
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    draw();
}
