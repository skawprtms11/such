/**
 * 업무프로세스 (모바일 앱 · 보기 전용).
 *
 *   #/process   업무구분 → 업무항목을 고르면 그 흐름을 세로 스테퍼(플로우차트)로 보여 준다
 *
 * 현장에서 매뉴얼을 펼쳐 보는 화면이다. 편집은 웹(업무프로세스 탭)에서만 한다.
 * 그리는 규칙은 웹 업무프로세스 탭과 같다 - 시작/끝, 프로세스 박스, 상황은 박스 아래 주황 블록
 * (「X 발생 시」 → 대응 체크항목·대응 단계 1→2→3 → 처리 후 다음 단계), 하위 프로세스는 박스 안 작은 사슬.
 *
 * 🔑 **합류(join)는 도식으로 그리지 않는다.** 세로 스테퍼는 그대로 두고 갈래 블록 끝에
 * 「↩ 갈래가 다시 ③ … 로 모입니다」 캡션 한 줄만 붙인다 (도식은 웹 업무프로세스 탭에만 있다).
 */
import * as db from '../../db.js';
import { CHECK_KIND, cycleLabel, isFork, isJoin } from '../../config.js';
import { forkBase, rowNos } from '../../checkflow.js';
import { esc } from '../../util.js';
import { emptyState, segment, pollGuard } from '../ui.js';

/** 보고 있던 업무구분·업무항목을 기억한다 */
const state = { division: null, group: null };

/** 도식 노드가 되는 하위인가 (체크항목·상황은 박스 안에 들어간다) */
function isStep(node) {
    return node.item.kind !== CHECK_KIND.CHECK && node.item.kind !== CHECK_KIND.SITUATION;
}

/**
 * 하위 프로세스 줄의 번호 🔑 - 웹과 같은 `checkflow.rowNos` 를 쓴다 (번호는 공유, 좌표는 웹 전용).
 * @param {Array} kids 트리 자식 전부 · @param {boolean} fork 갈래 줄인가
 * @param {number|string|null} no 부모 번호
 */
function stepNos(kids, fork, no) {
    return rowNos(kids.filter(isStep), {
        fork,
        base: forkBase(no),
        isBranch: (c) => isFork(c.item) && c.children.some(isStep),
    });
}

/** 캡션용 번호 - 정수는 `3.`, 갈래 줄의 점 번호는 `4.1` 그대로 */
function noText(no) {
    return /^\d+$/.test(String(no)) ? `${no}.` : String(no);
}

/**
 * 스테퍼 동글 - 정수만 적는다. 갈래 줄은 머리(`4.1 국내`)가 번호를 가지므로 가운뎃점만 찍는다
 * (번호를 두 번 적으면 좁은 화면에서 줄이 길어진다).
 */
function badgeNo(no) {
    return /^\d+$/.test(String(no)) ? String(no) : '·';
}

export async function render(root) {
    root.innerHTML = `
<div id="pick-div"></div>
<div id="pick-grp"></div>
<div id="flow"></div>`;
    const divHost = root.querySelector('#pick-div');
    const grpHost = root.querySelector('#pick-grp');
    const flowEl = root.querySelector('#flow');
    let divSeg = null;
    let grpSeg = null;

    async function reload() {
        const divisions = (await db.listChecklistDivisions()).filter((d) => d.active);
        if (!divisions.some((d) => d.id === state.division)) {
            state.division = divisions[0]?.id ?? null;
        }
        divSeg?.destroy();
        divSeg = null;
        if (divisions.length) {
            divSeg = segment(divHost, divisions.map((d) => ({ key: d.id, label: d.title })),
                state.division, (key) => {
                    state.division = key;
                    state.group = null;
                    reload();
                });
        }

        const groups = state.division
            ? (await db.listChecklistGroups(state.division)).filter((g) => g.active)
            : [];
        if (!groups.some((g) => g.id === state.group)) state.group = groups[0]?.id ?? null;
        grpSeg?.destroy();
        grpSeg = null;
        if (groups.length) {
            grpSeg = segment(grpHost, groups.map((g) => ({ key: g.id, label: g.title })),
                state.group, (key) => {
                    state.group = key;
                    reload();
                });
        }

        const division = divisions.find((d) => d.id === state.division);
        const group = groups.find((g) => g.id === state.group);
        if (!group) {
            flowEl.innerHTML = emptyState(divisions.length
                ? '이 업무구분에 업무항목이 없습니다.' : '등록된 업무프로세스가 없습니다.');
            return;
        }
        const rows = await db.listChecklistItems({ root: group.id });
        const tree = db.checklistTree(rows)[0];
        flowEl.innerHTML = flowHtml(division, group, tree);
    }

    await reload();
    return db.subscribe(pollGuard(root, reload), 15000);
}

/** 업무항목 한 벌의 흐름 */
function flowHtml(division, group, tree) {
    const kids = tree?.children ?? [];
    const processes = kids.filter((c) => c.item.kind === CHECK_KIND.PROCESS);
    const loose = kids.filter((c) => c.item.kind === CHECK_KIND.CHECK).map((c) => c.item);
    if (!processes.length && !loose.length) return emptyState('아직 프로세스가 없습니다.');
    const fork = isFork(group);
    const nos = stepNos(kids, fork, null);
    return `
<div class="m-fc">
  <p class="m-fc__crumb">${esc(division?.title ?? '')} › ${esc(group.title)}
    ${group.description ? ` · ${esc(group.description)}` : ''}</p>
  <span class="m-fc__term">시작</span>
  ${processes.map((p, i) => {
        const sib = !fork && processes[i + 1]
            ? { no: nos[i + 1], title: processes[i + 1].item.title } : null;
        return `
  <div class="m-fc__line"></div>
  ${fork ? `<p class="m-fc__fork-head">${esc(String(nos[i]))} ${esc(p.item.title)}</p>` : ''}
  ${stepHtml(p, nos[i], sib, sib)}`;
    }).join('')}
  ${loose.length ? `
  <div class="m-fc__line"></div>
  <div class="m-fc__step m-fc__loose">
    <span class="m-fc__no">·</span>
    <span class="m-fc__text"><span class="m-fc__title">단독 업무</span>
      <ul class="m-fc__items">${loose.map((r) => `<li>${esc(r.title)} <small>${esc(cycleLabel(r))}</small></li>`).join('')}</ul></span>
  </div>` : ''}
  <div class="m-fc__line"></div>
  <span class="m-fc__term">완료</span>
</div>`;
}

/**
 * 프로세스 한 단계 - 체크항목 목록, 하위 프로세스 사슬(또는 갈래), 상황 블록
 * @param {number|string} no 단계 번호. 갈래 줄이면 `4.1` 꼴이라 동글은 가운뎃점이 된다
 *   (하위 채번의 앞자리로도 쓰이므로 갈래 줄에서도 빼놓지 않고 넘긴다)
 * @param {{no:number|string,title:string}|null} next 이 단계 다음 단계 (상황 처리 후 돌아갈 곳)
 * @param {{no:number|string,title:string}|null} sib **다음 형제** - 합류(join) 하위가 모이는 곳.
 *   형제가 이어지지 않는 갈래 줄에서는 null 이라 합류 캡션 대신 주의 문구가 나간다
 */
function stepHtml(node, no, next, sib = null) {
    const kids = node.children;
    const checks = kids.filter((c) => c.item.kind === CHECK_KIND.CHECK).map((c) => c.item);
    const subs = kids.filter((c) => c.item.kind === CHECK_KIND.PROCESS);
    const sits = kids.filter((c) => c.item.kind === CHECK_KIND.SITUATION);
    const it = node.item;
    const fork = isFork(it);
    return `
<div class="m-fc__step">
  <span class="m-fc__no">${badgeNo(no)}</span>
  <span class="m-fc__text">
    <span class="m-fc__title">${esc(it.title)}</span>
    ${it.description ? `<span class="m-fc__desc">${esc(it.description)}</span>` : ''}
    ${it.assignee_name || (it.sub_assignees ?? []).length ? `<span class="m-fc__desc">담당 ${esc(it.assignee_name)}${(it.sub_assignees ?? []).length
        ? ` · 부 ${esc(it.sub_assignees.map((s) => s.name).join(', '))}` : ''}</span>` : ''}
    ${checks.length ? `<ul class="m-fc__items">${checks.map((r) => `
      <li>${esc(r.title)} <small>${esc(cycleLabel(r))}${r.daily ? '' : ' · 일일 제외'}</small></li>`).join('')}</ul>` : ''}
    ${!checks.length && !subs.length ? '<span class="m-fc__desc">단계 완료를 체크</span>' : ''}
    ${subsHtml(node.children, fork, next, no)}
    ${isJoin(it) && subs.length ? `<span class="m-fc__merge">${sib
        ? `↩ 갈래가 다시 ${noText(sib.no)} ${esc(sib.title)} 로 모입니다`
        : '↩ 합류할 다음 단계가 없습니다'}</span>` : ''}
  </span>
</div>
${sits.map((s) => sitHtml(s, next)).join('')}`;
}

/**
 * 하위 프로세스 묶음 - 순차면 사슬(①②③), 갈래면 `4.1 국내` 머리가 붙은 하위 스테퍼로 편다.
 * @param {Array} kids 부모의 트리 자식 전부 (프로세스만 골라 쓴다)
 * @param {boolean} fork 부모의 연결 방식이 갈래인지
 * @param {{no:number|string,title:string}|null} next 이 묶음이 끝난 뒤 이어갈 단계
 * @param {number|string|null} parentNo 부모 번호 (갈래 줄의 앞자리를 만든다)
 */
function subsHtml(kids, fork, next, parentNo) {
    const subs = kids.filter((c) => c.item.kind === CHECK_KIND.PROCESS);
    if (!subs.length) return '';
    const nos = stepNos(kids, fork, parentNo);
    const parts = subs.map((s, i) => {
        const head = fork
            ? `<p class="m-fc__fork-head">${esc(String(nos[i]))} ${esc(s.item.title)}</p>`
            : (i ? '<div class="m-fc__line"></div>' : '');
        // 합류 대상은 언제나 **다음 형제**다. 갈래 줄(fork)이나 마지막이면 모일 곳이 없다
        const sib = !fork && subs[i + 1]
            ? { no: nos[i + 1], title: subs[i + 1].item.title }
            : null;
        return `${head}${stepHtml(s, nos[i], sib ?? next, sib)}`;
    });
    return `<div class="${fork ? 'm-fc__fork' : 'm-fc__sub'}">${parts.join('')}</div>`;
}

/** 상황 블록 - 「X 발생 시」 → 대응 체크항목 · 대응 단계 → 처리 후 다음 단계 */
function sitHtml(node, next) {
    const it = node.item;
    const checks = node.children.filter((c) => c.item.kind === CHECK_KIND.CHECK).map((c) => c.item);
    const subs = node.children.filter((c) => c.item.kind === CHECK_KIND.PROCESS);
    return `
<div class="m-fc__sit">
  <div class="m-fc__sit-head">${esc(it.title)} 발생 시</div>
  ${it.description ? `<div class="m-fc__desc">${esc(it.description)}</div>` : ''}
  ${checks.length ? `<ul class="m-fc__items">${checks.map((r) => `<li>${esc(r.title)}</li>`).join('')}</ul>` : ''}
  ${subsHtml(node.children, isFork(it), next, null)}
  ${!checks.length && !subs.length ? '<div class="m-fc__desc">대응 절차 없음 · 발생 내용만 기록</div>' : ''}
  <div class="m-fc__merge">↩ 처리 후 ${next ? `${noText(next.no)} ${esc(next.title)} 로 이어감` : '흐름 마침'}</div>
</div>`;
}
