/**
 * Vite 빌드 설정 - 진입점 3개.
 *   index.html 로그인 · app.html 웹 셸 · m.html 모바일 앱 셸
 */
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
            // barcodes.html 은 개발용 테스트 시트라 배포하지 않는다.
            // 개발 서버(npm run dev)에서는 그대로 열린다
            input: {
                login: resolve(process.cwd(), 'index.html'),
                app: resolve(process.cwd(), 'app.html'),
                mobile: resolve(process.cwd(), 'm.html'),
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
            includeAssets: [
                'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
                'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
            ],
            manifest: {
                name: '더퓨어랩 수출 모니터링 시스템',
                short_name: '더퓨어랩',
                description: '주문 등록부터 검수·상차까지 실시간으로 확인하는 수출 모니터링 시스템',
                lang: 'ko',
                // 설치 아이콘은 하나만 둔다. 로그인 화면이 기기·소속으로 셸을 고른다
                start_url: 'index.html',
                scope: './',
                display: 'standalone',
                orientation: 'portrait',
                background_color: '#0f2d4a',
                theme_color: '#0f2d4a',
                // 홈화면 설치용 아이콘. iOS 는 SVG 를 쓰지 못해 PNG 가 반드시 필요하다.
                icons: [
                    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
                    {
                        // 안드로이드가 가장자리를 잘라내므로 여백을 둔 별도 아이콘을 쓴다
                        src: 'icons/icon-maskable-512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable',
                    },
                    { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
                ],
                // 설치한 아이콘을 길게 눌러 바로 여는 현장 작업 화면 (앱 셸)
                shortcuts: [
                    { name: '상차작업', url: 'm.html#/load' },
                    { name: '출고작업', url: 'm.html#/ship' },
                ],
            },
            workbox: {
                globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
                navigateFallback: null,
            },
            devOptions: {
                // 개발 서버에서도 PWA 설치를 확인할 수 있게 한다
                enabled: false,
            },
        }),
    ],
});
