import { config } from './config.js';

export type LogEvent = "log:out" | "log:err";

export interface TargetEventParams {
  ignores?:string[]
  matches?:string[]
}

export interface Target {
  events: {[key: LogEvent]: TargetEventParams}
}

export interface Packet {
  id: number;
  type: string;
  topic: boolean;
  data: string;
  process: Record<string, string>;
}

export interface Log {
  name: string;
  message: string;
}

export interface QData {
  event: string;
  name: string;
  message: string;
}
