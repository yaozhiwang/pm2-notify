export type LogConfig = {
  ignores?: string[];
  matches?: string[];
};

export type AppEvent = 'log:out' | 'log:err';

export type AppEventConfig = {
  AppEvent: LogConfig;
};

export type AppConfig = {
  events: { [event: string] : LogConfig };
};

export type Target = {
  [appName: string]: AppConfig;
};

export interface Packet {
  id: number
  type: string
  topic: boolean
  data: string
  process: Record<string, string>
}

export interface Log {
  name: string
  message: string
}

export interface QData {
  event: string
  name: string
  message: string
}
