/**
 * 업무프로세스 (모바일 앱 · 보기 전용).
 *
 *   #/process   업무구분 → 업무항목을 고르면 그 흐름을 세로 스테퍼(플로우차트)로 보여 준다
 *
 * 현장에서 매뉴얼을 펼쳐 보는 화면이다. 편집은 웹(업무프로세스 탭)에서만 한다.
 * 그리는 규칙은 웹 업무프로세스 탭과 같다 - 시작/끝, 프로세스 박스, 상황은 박스 아래 주황 블록
 * (「X 발생 시」 → 대응 체크항목·대응 단계 1→2→3 → 처리 후 다음 단계), 하위 프로세스는 박스 안 작은 사슬.
 */
import * as db from '../../db.js';
import { CHECK_KIND, cycleLabel } from '../../config.js';
import { esc } from '../../util.js';
import { emptyState, segment, pollGuard } from '../ui.js';

/** 보고 있던 업무구분·업무항목을 기억한다 */
const state = { division: null, group: null };

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
    return `
<div class="m-fc">
  <p class="m-fc__crumb">${esc(division?.title ?? '')} › ${esc(group.title)}
    ${group.description ? ` · ${esc(group.description)}` : ''}</p>
  <span class="m-fc__term">시작</span>
  ${processes.map((p, i) => `
  <div class="m-fc__line"></div>
  ${stepHtml(p, i + 1, processes[i + 1] ? { no: i + 2, title: processes[i + 1].item.title } : null)}`).join('')}
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
 * 프로세스 한 단계 - 체크항목 목록, 하위 프로세스 사슬, 상황 블록
 * @param {{no:number,title:string}|null} next 이 단계 다음 단계 (상황 처리 후 돌아갈 곳)
 */
function stepHtml(node, no, next) {
    const kids = node.children;
    const checks = kids.filter((c) => c.item.kind === CHECK_KIND.CHECK).map((c) => c.item);
    const subs = kids.filter((c) => c.item.kind === CHECK_KIND.PROCESS);
    const sits = kids.filter((c) => c.item.kind === CHECK_KIND.SITUATION);
    const it = node.item;
    return `
<div class="m-fc__step">
  <span class="m-fc__no">${no}</span>
  <span class="m-fc__text">
    <span class="m-fc__title">${esc(it.title)}</span>
    ${it.description ? `<span class="m-fc__desc">${esc(it.description)}</span>` : ''}
    ${it.assignee_name || (it.sub_assignees ?? []).length ? `<span class="m-fc__desc">담당 ${esc(it.assignee_name)}${(it.sub_assignees ?? []).length
        ? ` · 부 ${esc(it.sub_assignees.map((s) => s.name).join(', '))}` : ''}</span>` : ''}
    ${checks.length ? `<ul class="m-fc__items">${checks.map((r) => `
      <li>${esc(r.title)} <small>${esc(cycleLabel(r))}${r.daily ? '' : ' · 일일 제외'}</small></li>`).join('')}</ul>` : ''}
    ${!checks.length && !subs.length ? '<span class="m-fc__desc">단계 완료를 체크</span>' : ''}
    ${subs.length ? `<div class="m-fc__sub">${subs.map((s, i) => `
      ${i ? '<div class="m-fc__line"></div>' : ''}${stepHtml(s, i + 1,
    subs[i + 1] ? { no: i + 2, title: subs[i + 1].item.title } : next)}`).join('')}</div>` : ''}
  </span>
</div>
${sits.map((s) => sitHtml(s, next)).join('')}`;
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
  ${subs.map((s, i) => `
  ${i ? '<div class="m-fc__line"></div>' : ''}${stepHtml(s, i + 1,
    subs[i + 1] ? { no: i + 2, title: subs[i + 1].item.title } : next)}`).join('')}
  ${!checks.length && !subs.length ? '<div class="m-fc__desc">대응 절차 없음 · 발생 내용만 기록</div>' : ''}
  <div class="m-fc__merge">↩ 처리 후 ${next ? `${next.no}. ${esc(next.title)} 로 이어감` : '흐름 마침'}</div>
</div>`;
}
