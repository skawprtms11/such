/** 공통 유틸리티 모음 */

/** 오늘 날짜를 YYYY-MM-DD 로 반환 */
export function today() {
    return toDateStr(new Date());
}

/** Date 객체를 YYYY-MM-DD 문자열로 변환 */
export function toDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** ISO 문자열을 YYYY-MM-DD HH:MM 으로 변환 */
export function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${toDateStr(d)} ${String(d.getHours()).padStart(2, '0')}:` +
        `${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 숫자에 천단위 구분자를 붙인다 */
export function num(n) {
    return Number(n || 0).toLocaleString('ko-KR');
}

/** HTML 특수문자 이스케이프 (XSS 방지) */
export function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/** 짧은 안내 메시지 표시 */
export function toast(msg, type = 'info') {
    let box = document.getElementById('toast-box');
    if (!box) {
        box = document.createElement('div');
        box.id = 'toast-box';
        document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.className = `toast toast--${type}`;
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.classList.add('is-out'), 2200);
    setTimeout(() => t.remove(), 2600);
}

/** 확인 대화상자 (Promise 반환) */
export function confirmDialog(msg) {
    return Promise.resolve(window.confirm(msg));
}

/**
 * 배열을 CSV 파일로 내려받는다.
 * @param {string} filename 저장할 파일명
 * @param {string[]} headers 헤더 라벨 배열
 * @param {Array<Array>} rows 데이터 행 배열
 */
export function downloadCsv(filename, headers, rows) {
    const escCell = (v) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = [headers, ...rows].map((r) => r.map(escCell).join(',')).join('\r\n');
    // 엑셀에서 한글이 깨지지 않도록 BOM 을 붙인다
    const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** 간단한 고유 ID 생성 */
export function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 모바일 화면인지.
 * 기준점은 CSS 의 반응형 분기와 같은 860px 다. 한 곳에서만 정의한다.
 */
export const MOBILE_QUERY = '(max-width: 860px)';

export function isMobile() {
    return window.matchMedia(MOBILE_QUERY).matches;
}

/** ISO 날짜를 M/D 로 짧게 (모바일 표에서 쓴다) */
export function monthDay(iso) {
    const [, m, d] = String(iso).slice(0, 10).split('-');
    return m && d ? `${m}/${d}` : '-';
}

/** 추가주문 건수 배지 - 상차는 차수를 묶어 처리하므로 대표 행에 붙인다 */
export function addBadge(count) {
    return count > 1
        ? ` <span class="tag tag--amber" title="추가주문 ${count - 1}건 포함">+${count - 1}건</span>`
        : '';
}

/**
 * 차수 배지 - 2차수 이상은 주황색으로 구분한다.
 * @param {number} seq 차수
 * @param {string} [suffix] 표기 ('차수' 또는 좁은 화면용 '차')
 */
export function seqTag(seq, suffix = '차수') {
    return `<span class="seq ${seq > 1 ? 'seq--multi' : ''}">${seq}${suffix}</span>`;
}

/** 진행률(%) 계산 */
export function rate(done, total) {
    if (!total) return 0;
    return Math.round((done / total) * 100);
}

/**
 * 모달 열기
 * @param {string} title 제목
 * @param {string} contentHtml 본문 (길면 이 영역만 스크롤된다)
 * @param {{wide?:boolean, footer?:string}} opt
 *   wide   : 넓은 모달로 표시
 *   xl     : 더 넓은 모달로 표시 (탭이 있는 상세 팝업 등)
 *   footer : 본문 아래에 고정되는 영역. 스크롤과 무관하게 항상 보인다
 * @returns {{root:Element, body:Element, close:Function}}
 */
export function openModal(title, contentHtml, { wide = false, xl = false, footer = '' } = {}) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
<div class="modal ${wide ? 'modal--wide' : ''} ${xl ? 'modal--xl' : ''}">
  <div class="modal__head">
    <h3>${esc(title)}</h3>
    <button class="modal__close" type="button" aria-label="닫기">&times;</button>
  </div>
  <div class="modal__body">${contentHtml}</div>
  ${footer ? `<div class="modal__foot">${footer}</div>` : ''}
</div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector('.modal__close').addEventListener('click', close);
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    return {
        root: back,
        body: back.querySelector('.modal__body'),
        close,
    };
}
