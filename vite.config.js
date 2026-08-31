/** Vite 빌드 설정 - 로그인(index.html)과 앱 셸(app.html) 2개 페이지를 진입점으로 사용한다 */
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { resolve } from 'node:path';

/**
 * HTTPS 로 띄울지 여부 (npm run dev:https).
 * 휴대폰 카메라(getUserMedia)는 HTTPS 또는 localhost 에서만 동작하므로,
 * 실기기에서 바코드 스캔을 테스트하려면 HTTPS 가 필요하다.
 */
const USE_HTTPS = process.env.HTTPS === 'true';

/**
 * 개발 서버에서 /sw.js 요청에 "스스로를 해제하는" 서비스워커를 응답한다.
 * 개발 모드는 서비스워커를 쓰지 않는데, 예전에 등록된 서비스워커가 남아 있으면
 * 캐시된 옛 화면이 계속 표시되고 코드 수정이 반영되지 않는다.
 * 기본 상태에서는 Vite 가 /sw.js 에 index.html 을 반환해 갱신 자체가 실패하므로 직접 처리한다.
 */
function devUnregisterSw() {
    const script = [
        "self.addEventListener('install', () => self.skipWaiting());",
        "self.addEventListener('activate', (event) => {",
        '    event.waitUntil((async () => {',
        '        const keys = await caches.keys();',
        '        await Promise.all(keys.map((key) => caches.delete(key)));',
        '        await self.registration.unregister();',
        "        const windows = await self.clients.matchAll({ type: 'window' });",
        '        windows.forEach((client) => client.navigate(client.url));',
        '    })());',
        '});',
    ].join('\n');

    return {
        name: 'dev-unregister-sw',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.url?.split('?')[0] !== '/sw.js') {
                    next();
                    return;
                }
                res.setHeader('Content-Type', 'text/javascript');
                res.setHeader('Cache-Control', 'no-store');
                res.end(script);
            });
        },
    };
}

export default defineConfig({
    // 하위 경로에 배포해도 동작하도록 상대 경로를 사용한다
    base: './',

    server: {
        port: 5173,
        // 같은 와이파이의 휴대폰에서 접속해 모바일 화면을 테스트할 수 있게 한다
        host: true,
        open: '/index.html',
    },

    preview: {
        port: 4173,
        host: true,
    },

    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
        sourcemap: true,
        rollupOptions: {
            input: {
                login: resolve(process.cwd(), 'index.html'),
                app: resolve(process.cwd(), 'app.html'),
                barcodes: resolve(process.cwd(), 'barcodes.html'),
            },
        },
    },

    plugins: [
        // 자체 서명 인증서. 휴대폰에서는 경고 화면에서 '고급 → 계속' 을 눌러 진입한다
        ...(USE_HTTPS ? [basicSsl()] : []),
        devUnregisterSw(),
        VitePWA({
            // 새 버전 배포 시 서비스워커를 자동 갱신하고, 등록 스크립트를 HTML 에 주입한다
            registerType: 'autoUpdate',
            injectRegister: 'auto',
            includeAssets: ['icons/icon.svg'],
            manifest: {
                name: '더퓨어랩 주문접수시스템',
                short_name: '더퓨어랩',
                description: '주문 등록부터 검수·상차까지 실시간으로 관리하는 주문접수시스템',
                lang: 'ko',
                start_url: 'app.html',
                scope: './',
                display: 'standalone',
                orientation: 'portrait',
                background_color: '#0f2d4a',
                theme_color: '#0f2d4a',
                icons: [
                    {
                        src: 'icons/icon.svg',
                        sizes: 'any',
                        type: 'image/svg+xml',
                        purpose: 'any maskable',
                    },
                ],
                shortcuts: [
                    { name: '당일상차리스트', url: 'app.html#/loading' },
                    { name: '주문처리현황', url: 'app.html#/status' },
                ],
            },
            workbox: {
                globPatterns: ['**/*.{js,css,html,svg,woff2}'],
                navigateFallback: null,
            },
            devOptions: {
                // 개발 서버에서도 PWA 설치를 확인할 수 있게 한다
                enabled: false,
            },
        }),
    ],
});
