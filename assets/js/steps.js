/**
 * 출고 처리 단계 계산.
 * 주문처리현황·출고주문처리·당일상차리스트가 같은 규칙을 쓰도록 한곳에 모았다.
 * 단계 완료 여부는 주문의 시각 필드(예: ship_done_at)에 값이 있는지로 판단한다.
 */
import { WORK_STEPS } from './config.js';

/**
 * @typedef {object} StepOpt
 * @property {boolean} [task] 추가작업 요청이 등록되어 있는지
 * @property {{has:boolean, done:boolean}} [adjust] 조정요청 등록·완료 여부
 */

/** 옵션 기본값 보정 */
function norm(opt = {}) {
    return {
        task: Boolean(opt.task),
        adjust: opt.adjust ?? { has: false, done: false },
    };
}

/**
 * 해당 주문에서 화면에 보여야 할 단계 목록.
 * @param {object} order 주문
 * @param {StepOpt} opt 조건부 단계 판단에 쓰는 값
 * @returns {Array<{key:string, label:string, done:boolean, doneAt:string|null}>}
 */
export function visibleSteps(order, opt = {}) {
    const { task, adjust } = norm(opt);
    return WORK_STEPS
        .filter((s) => {
            if (s.cond === 'extra') return (order.extra_works ?? []).length > 0;
            if (s.cond === 'adjust') return adjust.has;
            if (s.cond === 'task') return task;
            return true;
        })
        .map((s) => {
            // 조정작업은 주문 필드가 아니라 조정요청 확인 상태로 판단한다
            if (s.key === 'adjust') {
                return { key: s.key, label: s.label, done: adjust.done, doneAt: null };
            }
            return {
                key: s.key,
                label: s.label,
                done: Boolean(order[s.at]),
                doneAt: order[s.at] ?? null,
            };
        });
}

/** 상차작업을 제외한 모든 단계가 끝났는지 (당일상차리스트 진입 조건) */
export function readyToLoad(order, opt = {}) {
    return visibleSteps(order, opt)
        .filter((s) => s.key !== 'load')
        .every((s) => s.done);
}

/** 진행률(%) - 보이는 단계 기준 */
export function stepRate(order, opt = {}) {
    const steps = visibleSteps(order, opt);
    if (!steps.length) return 0;
    return Math.round((steps.filter((s) => s.done).length / steps.length) * 100);
}

/** 현재 단계 이름 (다음에 해야 할 단계). 전부 끝났으면 마지막 단계명 */
export function currentStep(order, opt = {}) {
    const steps = visibleSteps(order, opt);
    const next = steps.find((s) => !s.done);
    return next ? next.label : (steps.at(-1)?.label ?? '');
}
