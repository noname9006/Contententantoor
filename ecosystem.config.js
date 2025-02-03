module.exports = {
  apps: [{
    name: 'discord-image-bot',
    script: 'hash.js',
    node_args: '--max-old-space-size=800 --expose-gc',
    watch: false,
    max_memory_restart: '850M',
    env: {
      NODE_ENV: 'production'
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: 'logs/pm2_error.log',
    out_file: 'logs/pm2_output.log',
    merge_logs: true,
    instances: 1,
    autorestart: true,
    exp_backoff_restart_delay: 100
  }]
};