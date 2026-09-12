import { createSeoulWorkerApp } from './worker-config.ts';
import type { SeoulWorkerEnv } from './worker-config.ts';

export default {
  fetch(request, env) {
    return createSeoulWorkerApp(env).fetch(request, env);
  },
} satisfies ExportedHandler<SeoulWorkerEnv>;
