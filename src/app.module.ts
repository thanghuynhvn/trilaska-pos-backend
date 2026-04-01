import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WinstonModule } from 'nest-winston';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { envValidationSchema } from './config/index.js';
import { winstonConfig } from './common/index.js';
import { HealthModule } from './health/health.module.js';
import { InitialSchema1711700000000 } from './migrations/1711700000000-InitialSchema.js';
import { SeedTaxRates1711700000001 } from './migrations/1711700000001-SeedTaxRates.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: false,
      },
    }),

    WinstonModule.forRoot(winstonConfig),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('DATABASE_HOST'),
        port: config.get<number>('DATABASE_PORT'),
        database: config.get<string>('DATABASE_NAME'),
        username: config.get<string>('DATABASE_USER'),
        password: config.get<string>('DATABASE_PASSWORD'),
        namingStrategy: new SnakeNamingStrategy(),
        autoLoadEntities: true,
        synchronize: false,
        migrationsRun: true,
        migrations: [InitialSchema1711700000000, SeedTaxRates1711700000001],
        logging: config.get<string>('NODE_ENV') === 'development',
      }),
    }),

    HealthModule,
  ],
})
export class AppModule {}
