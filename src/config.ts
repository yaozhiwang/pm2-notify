import 'dotenv/config';
import fs from 'node:fs';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Target } from './types.js';

const { env } = process;
const {
  NODE_ENV = 'localhost',
  USER = userInfo().username,
  HOSTNAME = hostname(),
  PM2_APPS = '.apps.yaml',
} = env;

const dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  // https://nodemailer.com/message
  mail: {
    subject: `Error - ${USER}@${HOSTNAME}:${NODE_ENV}`,
    from: env.MAIL_FROM || 'me <from@test.com>',
    to: env.MAIL_TO || 'to@test.com',
  },
  // https://nodemailer.com/smtp
  smtp: {
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  },
  /**
   * https://pm2.keymetrics.io/docs/usage/application-declaration/#general
   * appName is the value assigned to `--name` in PM2
   * ['api', 'server', 'admin', ...]
   */
  target: YAML.parse(fs.readFileSync(PM2_APPS, 'utf8')) as Target,
  // MJML template
  template: `${dirname}/../views/template.html`,
  // Send mail every timeout(ms)
  timeout: Number(env.SEND_INTERVAL) || 10000,
};
