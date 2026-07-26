// PM2 ecosystem: 로컬 컴이 프로덕션 워커 VM 역할할 때 쓴다.
// 실행: pm2 start ecosystem.config.cjs && pm2 save
// 업데이트: pm2 restart stepd-worker (git pull 후)
// 상태: pm2 status · pm2 logs stepd-worker · pm2 monit
// 부팅 자동: pm2 startup (Windows는 pm2-installer 또는 nssm 필요 · docs 확인)

const path = require('path');
const ROOT = __dirname;
const SA_KEY = 'C:\\Users\\STEPAI05\\stepd-deployer-key.json';

module.exports = {
  apps: [
    // 1) Cloud SQL Auth Proxy: 127.0.0.1:5434 -> step-d:us-central1:stepd-db
    {
      name: 'cloud-sql-proxy',
      script: 'C:\\Users\\STEPAI05\\cloud-sql-proxy\\cloud-sql-proxy.exe',
      args: [
        '--address', '127.0.0.1',
        '--port', '5434',
        '--credentials-file', SA_KEY,
        'step-d:us-central1:stepd-db',
      ],
      interpreter: 'none', // native exe · Node로 감싸지 마
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      out_file: path.join(ROOT, 'logs', 'pm2-proxy.log'),
      error_file: path.join(ROOT, 'logs', 'pm2-proxy.err'),
      merge_logs: true,
      time: true,
    },

    // 2) STEP-D worker: Cloud SQL job_queue 폴링 + python -m core.analyze 스폰
    {
      name: 'stepd-worker',
      cwd: path.join(ROOT, 'apps', 'server'),
      script: 'src/worker.ts',
      interpreter: process.execPath,        // node
      interpreter_args: [
        '--unhandled-rejections=warn',
        '--import', 'tsx',
        '--env-file-if-exists=.env.worker', // 프로덕션 env (Cloud SQL·GCS·Vertex)
      ],
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: SA_KEY,
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      min_uptime: '15s',                    // 15초 안에 죽으면 실패로 카운트
      exp_backoff_restart_delay: 200,       // 지수 백오프 (crash loop 방어)
      kill_timeout: 30000,                  // SIGTERM 후 30초 대기 (Python subprocess 정리)
      out_file: path.join(ROOT, 'logs', 'pm2-worker.log'),
      error_file: path.join(ROOT, 'logs', 'pm2-worker.err'),
      merge_logs: true,
      time: true,
    },

    // NOTE: analysis-sync-daemon은 STEPD_API_BASE로 로컬 서버(4100)를 부른다.
    // 프로덕션 워커 모드에선 서버가 Cloud Run (IAM 필요) · 인증 배관 필요해 제외.
    // 필요해지면 별도 앱으로 등록 (ID 토큰 헤더 붙여야 함).
  ],
};
