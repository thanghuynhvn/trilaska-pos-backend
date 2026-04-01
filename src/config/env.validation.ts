import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  // Application
  APP_PORT: Joi.number().default(3000),
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  // Database
  DATABASE_HOST: Joi.string().required(),
  DATABASE_PORT: Joi.number().default(5432),
  DATABASE_NAME: Joi.string().required(),
  DATABASE_USER: Joi.string().required(),
  DATABASE_PASSWORD: Joi.string().required(),

  // JWT
  JWT_PRIVATE_KEY_PATH: Joi.string().required(),
  JWT_PUBLIC_KEY_PATH: Joi.string().required(),
  JWT_ACCESS_TTL: Joi.number().default(900),
  JWT_REFRESH_TTL: Joi.number().default(604800),

  // ERP Adapter
  ERP_MODE: Joi.string().valid('mock', 'live').default('mock'),
  ERPNEXT_BASE_URL: Joi.string().uri().when('ERP_MODE', {
    is: 'live',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  ERPNEXT_API_KEY: Joi.string().allow('').optional(),
  ERPNEXT_API_SECRET: Joi.string().allow('').optional(),

  // Mock Adapter
  MOCK_FAILURE_RATE: Joi.number().min(0).max(1).default(0.0),
  MOCK_FAILURE_TYPE: Joi.string()
    .valid('5xx', 'timeout', '400', '404')
    .default('5xx'),
  MOCK_FORWARD_DELAY_MS: Joi.number().min(0).default(100),

  // Rate Limiting
  RATE_LIMIT_DEVICE_RPM: Joi.number().default(10),
  RATE_LIMIT_MSME_SYNC_RPH: Joi.number().default(30),
  RATE_LIMIT_LOGIN_PER_PHONE: Joi.number().default(5),
  RATE_LIMIT_LOGIN_PER_IP: Joi.number().default(20),

  // Sync Worker
  SYNC_WORKER_POLL_INTERVAL_MS: Joi.number().default(1000),
  SYNC_WORKER_RETRY_BASE_MS: Joi.number().default(2000),
  SYNC_WORKER_RETRY_MAX_MS: Joi.number().default(32000),
  SYNC_WORKER_RETRY_JITTER_MS: Joi.number().default(500),

  // Circuit Breaker
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: Joi.number().default(5),
  CIRCUIT_BREAKER_COOLDOWN_MS: Joi.number().default(30000),
});
