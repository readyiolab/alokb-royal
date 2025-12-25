const cluster = require('cluster');
const os = require('os');
const app = require('./app');

const PORT = process.env.PORT || 5000;
const WORKERS = process.env.WEB_CONCURRENCY || os.cpus().length;

if (cluster.isMaster || cluster.isPrimary) {
  // Master process
  console.log(`🎯 Master process ${process.pid} is running`);
  console.log(`🔧 Starting ${WORKERS} workers...`);

  // Track worker restarts
  const workerRestarts = new Map();
  const MAX_RESTARTS = 5;
  const RESTART_WINDOW = 60000; // 1 minute

  // Fork workers
  for (let i = 0; i < WORKERS; i++) {
    const worker = cluster.fork();
    console.log(`✅ Worker ${worker.process.pid} started`);
  }

  // Handle worker exit
  cluster.on('exit', (worker, code, signal) => {
    const now = Date.now();
    const restarts = workerRestarts.get(worker.id) || [];
    
    // Clean old restart records
    const recentRestarts = restarts.filter(time => now - time < RESTART_WINDOW);
    
    if (signal) {
      console.log(`⚠️  Worker ${worker.process.pid} was killed by signal: ${signal}`);
    } else if (code !== 0) {
      console.log(`❌ Worker ${worker.process.pid} exited with error code: ${code}`);
    } else {
      console.log(`⚡ Worker ${worker.process.pid} exited successfully`);
    }

    // Check if we should restart the worker
    if (recentRestarts.length < MAX_RESTARTS) {
      console.log(`🔄 Starting a new worker...`);
      const newWorker = cluster.fork();
      workerRestarts.set(newWorker.id, [...recentRestarts, now]);
      console.log(`✅ New worker ${newWorker.process.pid} started`);
    } else {
      console.error(`🚨 Worker restarted ${MAX_RESTARTS} times in ${RESTART_WINDOW}ms. Not restarting.`);
      console.error('🚨 Check application logs for errors!');
    }
  });

  // Handle worker messages
  cluster.on('message', (worker, message) => {
    console.log(`📨 Message from worker ${worker.process.pid}:`, message);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n🛑 Master received shutdown signal');
    console.log('📢 Sending shutdown signal to all workers...');
    
    for (const id in cluster.workers) {
      cluster.workers[id].send('shutdown');
    }

    // Force kill after 10 seconds
    setTimeout(() => {
      console.log('⏰ Forcing shutdown...');
      for (const id in cluster.workers) {
        cluster.workers[id].kill();
      }
      process.exit(0);
    }, 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

} else {
  // Worker process
  const server = app.listen(PORT, () => {
    console.log(`🚀 Worker ${process.pid} - Cashier API Server running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  });

  // Graceful shutdown for worker
  process.on('message', (msg) => {
    if (msg === 'shutdown') {
      console.log(`🛑 Worker ${process.pid} received shutdown signal`);
      
      server.close(() => {
        console.log(`✅ Worker ${process.pid} closed all connections`);
        process.exit(0);
      });

      // Force close after 5 seconds
      setTimeout(() => {
        console.error(`⏰ Worker ${process.pid} forcing shutdown`);
        process.exit(1);
      }, 5000);
    }
  });

  // Handle uncaught errors
  process.on('uncaughtException', (err) => {
    console.error(`❌ Worker ${process.pid} uncaught exception:`, err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error(`❌ Worker ${process.pid} unhandled rejection at:`, promise, 'reason:', reason);
    process.exit(1);
  });
}