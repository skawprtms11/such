/**
 * 유통가공작업 화면의 공용 조각 - 상태 배지·구분 배지·버튼·구성품 줄 묶기.
 * 탭 모듈(jobs · jobform · calendar · master · doc)이 같은 모양을 쓰도록 여기 한 곳에 둔다.
 *
 * 🔑 문자열은 모두 `config.js` 에서 가져온다. 화면 코드에 '제품' '대기' 를 직접 쓰지 않는다.
 */
import { icon } from '../../icons.js';
import {
    PROCESS_ITEM_KIND, PROCESS_STATUSES, PROCESS_STATUS_TONE, PROCESS_WORK_TYPES,
} from '../../config.js';
import { esc, toast } from '../../util.js';

/**
 * `await` 없이 부르는 비동기 팝업을 감싼다 🔑
 *
 * 목록·캘린더의 클릭 핸들러는 팝업을 열어 두고 바로 끝난다. 팝업 안에서 조회가 실패하면
 * 아무 일도 일어나지 않은 것처럼 보이고(처리되지 않은 rejection) 사용자는 이유를 알 수 없다.
 */
export function openSafe(promise) {
    Promise.resolve(promise).catch((err) => toast(err.message, 'error'));
}

/** 아이콘 버튼 한 개 - 문구 대신 아이콘만 두므로 aria-label·title 로 뜻을 알린다 */
export function iconBtn(name, label, attr, cls = 'btn btn--icon btn--sm') {
    return `<button class="${cls}" type="button" ${attr}
        aria-label="${esc(label)}" title="${esc(label)}">${icon(name, 'icon icon--sm')}</button>`;
}

/** 진행상태 색 이름 (.tag--* · .pc-bar--* 가 함께 쓴다) */
export function statusTone(status) {
    return PROCESS_STATUS_TONE[status] ?? 'gray';
}

/** 진행상태 배지 - 색은 config 의 PROCESS_STATUS_TONE 이 정한다 */
export function statusTag(status) {
    return `<span class="tag tag--${statusTone(status)}">${esc(status)}</span>`;
}

/** 구성품 구분 배지 - 제품(파랑)과 부자재(회색)를 한눈에 가른다 */
export function kindTag(kind) {
    const tone = kind === PROCESS_ITEM_KIND.PRODUCT ? 'blue' : 'gray';
    return `<span class="tag tag--${tone}">${esc(kind)}</span>`;
}

/** select 의 option 목록 (첫 줄은 전체) */
export function optionsHtml(values, cur, allLabel = '전체') {
    return [`<option value="">${esc(allLabel)}</option>`]
        .concat(values.map((v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}
            >${esc(v)}</option>`)).join('');
}

/** 작업구분 select 의 option */
export function workTypeOptions(cur, allLabel = '전체') {
    return optionsHtml(PROCESS_WORK_TYPES, cur, allLabel);
}

/** 진행상태 select 의 option */
export function statusOptions(cur) {
    return optionsHtml(PROCESS_STATUSES, cur);
}

/** 빈 목록 한 줄 */
export function emptyRow(cols, msg) {
    return `<tr><td colspan="${cols}" class="empty">${esc(msg)}</td></tr>`;
}

/**
 * 작업 구성품 행을 **구성품 줄(`line_no`)로 묶는다.**
 * 한 줄 안의 LOT 행들이 `rows` 에 순서대로 들어간다 (상세 팝업·작업지시서가 함께 쓴다).
 */
export function groupLines(items) {
    const byLine = new Map();
    (items ?? []).forEach((it) => {
        if (!byLine.has(it.line_no)) {
            byLine.set(it.line_no, {
                line_no: it.line_no,
                kind: it.kind,
                code: it.code,
                name: it.name,
                qty_per: it.qty_per,
                rows: [],
            });
        }
        byLine.get(it.line_no).rows.push(it);
    });
    return [...byLine.values()].sort((a, b) => a.line_no - b.line_no);
}
