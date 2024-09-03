import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
    test: {
        poolOptions: {
            workers: {
                wrangler: { configPath: "./wrangler.toml" },
            },
        },
        watch: {
            clearCache: true,
            silent: true,
            dirs: ['.'],
            extensions: ['js'],
            ignore: ['node_modules'],
        },
    },
});
