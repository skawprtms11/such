/**
 * 업무체크리스트 화면의 공용 조각 - 버튼·세그먼트·담당 표시·빠른 추가 줄.
 * 탭 모듈(daily · process · flowview · form)이 같은 모양을 쓰도록 여기 한 곳에 둔다.
 */
import * as db from '../../db.js';
import { icon } from '../../icons.js';
import { CHECK_KIND } from '../../config.js';
import { esc } from '../../util.js';

/** 업무구분이 없는 옛 업무항목을 담는 가상 업무구분 (스키마 마이그레이션 전 데이터 · mock) */
export const UNSORTED_ID = '';

/** 아이콘 버튼 한 개 - 문구 대신 아이콘만 두므로 aria-label·title 로 뜻을 알린다 */
export function iconBtn(name, label, attr, cls = 'btn btn--icon btn--sm') {
    return `<button class="${cls}" type="button" ${attr}
        aria-label="${esc(label)}" title="${esc(label)}">${icon(name, 'icon icon--sm')}</button>`;
}

/** 아이콘 + 짧은 글자 버튼 (「+ 체크항목」 같은 것) */
export function textBtn(name, label, attr, cls = 'btn btn--sm') {
    return `<button class="${cls}" type="button" ${attr}>
        ${icon(name, 'icon icon--sm')}<span>${esc(label)}</span></button>`;
}

/** 세그먼트 (미완료|전체 · 일일|전체 · 구성|흐름|체크리스트) */
export function segHtml(id, items, cur) {
    return `<span class="seg" id="${id}">${items.map(([k, label]) => `
<button class="seg__btn ${k === cur ? 'is-active' : ''}" type="button" data-seg="${esc(k)}"
  >${esc(label)}</button>`).join('')}</span>`;
}

/**
 * ①②③ 원문자 - 프로세스 순번 캡션용 (20 넘으면 숫자 그대로).
 * 🔑 **갈래 줄의 점 번호(`4.1`)는 원문자로 바꿀 수 없으므로 원문을 그대로 돌려준다.**
 * 혼용이 그대로 신호가 된다 - 원문자는 한 줄기, 점 번호는 갈래다.
 */
export function circled(n) {
    if (!/^\d+$/.test(String(n))) return String(n);
    return n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : String(n);
}

/**
 * 순번 캡션 - 번호가 없는 노드(상황)는 이름만 읽는다.
 * @param {{title:string, no:number|string|null}} node 갈래 줄이면 `no` 가 `4.1` 꼴 문자열이다
 */
export function stepCaption(node) {
    return node.no == null ? esc(node.title) : `${circled(node.no)} ${esc(node.title)}`;
}

/** 담당자 표시 - 정담당자 · 부담당자(여러 명) */
export function whoHtml(it) {
    const subs = it.sub_assignees ?? [];
    if (!it.assignee_name && !subs.length) return '';
    return `<span class="pm-who">${icon('account', 'icon icon--sm')}${esc(it.assignee_name)}${subs.length
        ? `<small>부 ${esc(subs.map((s) => s.name).join(', '))}</small>` : ''}</span>`;
}

/** 편집 도구 - 속성 열기 ✎ */
export function openBtn(item, what) {
    return `<span class="pm-tools">${iconBtn('edit', `${what} 수정`, `data-open="${esc(item.id)}"`)}</span>`;
}

/**
 * 빠른 추가 줄 - 「+ 체크항목」 「+ 상황」 … 을 누르면 이름 입력칸이 열리고 Enter 로 바로 등록된다.
 * 등록 뒤에도 입력칸이 열린 채라 연달아 넣을 수 있다 (state.quick).
 */
export function quickBar(item, main = false) {
    const kinds = db.allowedChildKinds(item.kind);
    const label = {
        [CHECK_KIND.CHECK]: item.kind === CHECK_KIND.GROUP ? '단독 체크항목' : '체크항목',
        [CHECK_KIND.SITUATION]: '상황',
        [CHECK_KIND.PROCESS]: item.kind === CHECK_KIND.GROUP ? '다음 프로세스'
            : (item.kind === CHECK_KIND.SITUATION ? '대응 프로세스' : '하위 프로세스'),
    };
    return `
<div class="pm-quick ${main ? 'pm-quick--main' : ''}" data-quick-host="${esc(item.id)}">
  ${kinds.map((k) => textBtn('plus', label[k],
        `data-quick="${esc(item.id)}" data-kind="${esc(k)}" data-label="${esc(label[k])}"`,
        `btn btn--sm pm-add ${main && k === CHECK_KIND.PROCESS ? 'btn--primary' : ''}`)).join('')}
</div>`;
}
