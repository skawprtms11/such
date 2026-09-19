/**
 * 빌드 버전 - vite.config.js 의 define 이 빌드 시점에 넣는 문자열.
 *   예: 0.1.0+3eb5c86 · 2026-09-19 15:20
 * 현장 기기가 옛 캐시(PWA)를 쓰고 있는지 확인할 때 계정 화면·웹 사이드바에서 본다.
 */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
