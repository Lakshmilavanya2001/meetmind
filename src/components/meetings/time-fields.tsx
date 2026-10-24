"use client";

import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/form-field";

export const DURATIONS = [15, 30, 45, 60, 90, 120, 180];

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30";

export type TimeValue = { date: string; time: string; duration: number; timezone: string };

export function TimeFields({ value, onChange, errors = {} }: { value: TimeValue; onChange: (v: TimeValue) => void; errors?: Record<string, string> }) {
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField id="m-date" label="Date" error={errors.startTime}>
        <Input id="m-date" type="date" required value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} />
      </FormField>
      <FormField id="m-time" label="Start time">
        <Input id="m-time" type="time" required step={300} value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} />
      </FormField>
      <FormField id="m-duration" label="Duration" error={errors.endTime}>
        <select id="m-duration" className={selectClass} value={value.duration} onChange={(e) => onChange({ ...value, duration: Number(e.target.value) })}>
          {DURATIONS.map((d) => (
            <option key={d} value={d}>{d < 60 ? `${d} min` : `${d / 60} h${d % 60 ? ` ${d % 60} min` : ""}`}</option>
          ))}
        </select>
      </FormField>
      <FormField id="m-tz" label="Time zone">
        <select id="m-tz" className={selectClass} value={value.timezone} onChange={(e) => onChange({ ...value, timezone: e.target.value })}>
          {!zones.includes(value.timezone) && <option value={value.timezone}>{value.timezone}</option>}
          {zones.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </FormField>
    </div>
  );
}
