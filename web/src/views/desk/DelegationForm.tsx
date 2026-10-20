import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  Delegation,
  DelegationCreateRequest,
  DelegationStatus,
  DelegationUpdateRequest,
} from '../../../../src/dashboard/desk-types';
import { Button, DetailsPanel, Select } from '../../ui';
import { STATUSES, STATUS_LABEL, createDelegation, updateDelegation } from './data';
import './details.css';

// the owner's form to create a delegation, or to edit one: title, details, next step, waiting on (name and email),
// due and follow-up times, and the status of an edit. it sends POST /api/desk/delegations or
// POST /api/desk/delegations/:id and shows the error text of a 400 or a 409 by the form. the work package "details
// panel and form" builds it.
export type DelegationFormProps =
  | { mode: 'create'; onDone: (delegation: Delegation) => void; onCancel: () => void }
  | { mode: 'edit'; delegation: Delegation; onDone: (delegation: Delegation) => void; onCancel: () => void };

// the limits of the server (LIMITS in src/desk/shared.ts), so the form says so before it sends.
export const FORM_LIMITS = { title: 200, details: 4_000, nextStep: 500, name: 200, email: 320 } as const;

// a counter shows from this share of the limit on, so a short text has no noise next to it.
const NEAR_LIMIT = 0.8;

// one address with no space, one @ and a dot in the domain. the server checks it again.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Values {
  title: string;
  details: string;
  nextStep: string;
  name: string;
  email: string;
  dueDate: string;
  dueTime: string;
  followDate: string;
  followTime: string;
  status: DelegationStatus;
}

type FieldName = keyof Values;
type Errors = Partial<Record<FieldName, string>>;

const pad = (value: number) => String(value).padStart(2, '0');

// the day and the time of an iso time in the time zone of the browser, for the date and time inputs.
export function localParts(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { date: '', time: '' };
  return { date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, time: `${pad(at.getHours())}:${pad(at.getMinutes())}` };
}

// the time to send for a date input and a time input. a day alone goes as yyyy-mm-dd, which the server reads in the
// time zone of the app (the end of the day for a due time, 09:00 for a follow-up). a day with a time is the local
// time of the browser, sent as an iso time with its exact offset.
export function whenOf(date: string, time: string): string | null {
  if (!date) return null;
  if (!time) return date;
  const at = new Date(`${date}T${time}`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function initialValues(delegation: Delegation | null): Values {
  const due = localParts(delegation?.dueAt ?? null);
  const follow = localParts(delegation?.nextFollowUpAt ?? null);
  return {
    title: delegation?.title ?? '',
    details: delegation?.details ?? '',
    nextStep: delegation?.nextStep ?? '',
    name: delegation?.waitingOn?.name ?? '',
    email: delegation?.waitingOn?.email ?? '',
    dueDate: due.date,
    dueTime: due.time,
    followDate: follow.date,
    followTime: follow.time,
    status: delegation?.status ?? 'open',
  };
}

const LENGTH_FIELDS: Array<[FieldName, keyof typeof FORM_LIMITS]> = [
  ['title', 'title'],
  ['details', 'details'],
  ['nextStep', 'nextStep'],
  ['name', 'name'],
  ['email', 'email'],
];

// the checks of the form before it sends. each error goes next to its field.
function check(values: Values, mode: 'create' | 'edit', followChanged: boolean, now: Date): Errors {
  const errors: Errors = {};
  if (!values.title.trim()) errors.title = 'Give the delegation a title.';
  for (const [field, limit] of LENGTH_FIELDS) {
    const max = FORM_LIMITS[limit];
    if (values[field].trim().length > max) errors[field] = `This can have at most ${max} characters.`;
  }
  const email = values.email.trim();
  if (email && !errors.email && !EMAIL.test(email)) errors.email = 'Give one email address, like name@example.com.';
  if (mode === 'edit' && values.status === 'waiting' && !values.name.trim() && !email) errors.name = 'A waiting delegation needs a person or an email.';
  if (values.dueTime && !values.dueDate) errors.dueDate = 'Give a day for this time.';
  if (values.followTime && !values.followDate) errors.followDate = 'Give a day for this time.';
  else if (values.followDate && followChanged) {
    const today = localParts(now.toISOString()).date;
    const when = whenOf(values.followDate, values.followTime);
    const past = values.followTime ? when !== null && Date.parse(when) < now.getTime() : values.followDate < today;
    if (past) errors.followDate = 'The follow-up time is in the past.';
  }
  return errors;
}

// the waiting on of a request: the filled parts, or null when both are empty.
function waitingOf(values: Values): { name?: string; email?: string } | null {
  const name = values.name.trim();
  const email = values.email.trim();
  if (!name && !email) return null;
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
}

function createBody(values: Values): DelegationCreateRequest {
  const waitingOn = waitingOf(values);
  const dueAt = whenOf(values.dueDate, values.dueTime);
  const nextFollowUpAt = whenOf(values.followDate, values.followTime);
  return {
    title: values.title.trim(),
    ...(values.details.trim() ? { details: values.details.trim() } : {}),
    ...(values.nextStep.trim() ? { nextStep: values.nextStep.trim() } : {}),
    ...(waitingOn ? { waitingOn } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(nextFollowUpAt ? { nextFollowUpAt } : {}),
  };
}

// the fields that the owner changed, and null for a field that the owner cleared. a time is compared by its inputs,
// so a time that the owner did not touch is not sent again with other seconds.
function updateBody(values: Values, before: Values): DelegationUpdateRequest {
  const body: DelegationUpdateRequest = {};
  const title = values.title.trim();
  if (title !== before.title.trim()) body.title = title;
  for (const field of ['details', 'nextStep'] as const) {
    const value = values[field].trim();
    if (value !== before[field].trim()) body[field] = value || null;
  }
  if (values.name.trim() !== before.name.trim() || values.email.trim() !== before.email.trim()) body.waitingOn = waitingOf(values);
  if (values.dueDate !== before.dueDate || values.dueTime !== before.dueTime) body.dueAt = whenOf(values.dueDate, values.dueTime);
  if (values.followDate !== before.followDate || values.followTime !== before.followTime) body.nextFollowUpAt = whenOf(values.followDate, values.followTime);
  if (values.status !== before.status) body.status = values.status;
  return body;
}

function Counter({ length, max, always }: { length: number; max: number; always?: boolean }) {
  if (!always && length < max * NEAR_LIMIT) return null;
  return (
    <span className={`desk-counter${length > max ? ' is-over' : ''}`} aria-live="polite">
      {length}/{max}
    </span>
  );
}

// a label above its input, with an optional counter on the right and the error of the field under it.
function Field({
  id,
  label,
  error,
  counter,
  hint,
  children,
}: {
  id: string;
  label: ReactNode;
  error: string | undefined;
  counter?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`desk-field${error ? ' is-invalid' : ''}`}>
      <div className="desk-field-head">
        <label className="desk-label" htmlFor={id}>
          {label}
        </label>
        {counter}
      </div>
      {children}
      {hint ? <p className="desk-hint">{hint}</p> : null}
      {error ? (
        <p className="desk-field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function DelegationForm(props: DelegationFormProps) {
  const { mode, onDone, onCancel } = props;
  const original = mode === 'edit' ? props.delegation : null;
  const [before] = useState(() => initialValues(original));
  const [values, setValues] = useState(before);
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const base = useId();
  const id = (field: FieldName) => `${base}-${field}`;

  // escape cancels the form. the listener is on the form itself, so it runs before the drawer of a narrow screen
  // closes on the same key, and an edit goes back to the details instead of closing the drawer.
  useEffect(() => {
    const node = formRef.current;
    if (!node) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancel.current();
    };
    node.addEventListener('keydown', onKey);
    return () => node.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => titleRef.current?.focus(), []);

  const set = (field: FieldName) => (value: string) => {
    setValues((old) => ({ ...old, [field]: value }));
    if (errors[field]) setErrors((old) => ({ ...old, [field]: undefined }));
    // the person error belongs to both inputs of waiting on, and to the status.
    if ((field === 'email' || field === 'status') && errors.name) setErrors((old) => ({ ...old, name: undefined }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const followChanged = mode === 'create' || values.followDate !== before.followDate || values.followTime !== before.followTime;
    const found = check(values, mode, followChanged, new Date());
    setErrors(found);
    const first = (Object.keys(found) as FieldName[]).find((field) => found[field]);
    if (first) {
      document.getElementById(id(first))?.focus();
      return;
    }
    setServerError(null);
    setBusy(true);
    const request = original ? updateDelegation(original.id, updateBody(values, before)) : createDelegation(createBody(values));
    request.then(
      (delegation) => {
        setBusy(false);
        onDone(delegation);
      },
      (err: Error) => {
        setBusy(false);
        setServerError(err.message);
      },
    );
  };

  const input = (field: FieldName, extra: { type?: string; autoComplete?: string; ref?: typeof titleRef; required?: boolean } = {}) => (
    <input
      id={id(field)}
      type={extra.type ?? 'text'}
      value={values[field]}
      onChange={(event) => set(field)(event.target.value)}
      aria-invalid={errors[field] ? true : undefined}
      aria-describedby={errors[field] ? `${id(field)}-error` : undefined}
      autoComplete={extra.autoComplete ?? 'off'}
      required={extra.required}
      ref={extra.ref}
    />
  );

  return (
    <form ref={formRef} className="desk-form" onSubmit={submit} noValidate aria-label={mode === 'create' ? 'New delegation' : 'Edit the delegation'}>
      {serverError !== null ? (
        <p className="error-box desk-form-error" role="alert">
          {serverError}
        </p>
      ) : null}
      <Field id={id('title')} label="Title" error={errors.title} counter={<Counter length={values.title.trim().length} max={FORM_LIMITS.title} always />}>
        {input('title', { ref: titleRef, required: true })}
      </Field>
      <Field id={id('details')} label="Details" error={errors.details} counter={<Counter length={values.details.trim().length} max={FORM_LIMITS.details} />}>
        <textarea
          id={id('details')}
          rows={4}
          value={values.details}
          onChange={(event) => set('details')(event.target.value)}
          aria-invalid={errors.details ? true : undefined}
          aria-describedby={errors.details ? `${id('details')}-error` : undefined}
        />
      </Field>
      <Field id={id('nextStep')} label="Next step" error={errors.nextStep} counter={<Counter length={values.nextStep.trim().length} max={FORM_LIMITS.nextStep} />}>
        {input('nextStep')}
      </Field>
      <div className="desk-pair">
        <Field id={id('name')} label="Waiting on, name" error={errors.name} counter={<Counter length={values.name.trim().length} max={FORM_LIMITS.name} />}>
          {input('name')}
        </Field>
        <Field id={id('email')} label="Waiting on, email" error={errors.email} counter={<Counter length={values.email.trim().length} max={FORM_LIMITS.email} />}>
          {input('email', { type: 'email', autoComplete: 'off' })}
        </Field>
      </div>
      <div className="desk-pair">
        <Field id={id('dueDate')} label="Due" error={errors.dueDate} hint="Without a time, the end of the day.">
          <div className="desk-when">
            {input('dueDate', { type: 'date' })}
            <input
              type="time"
              aria-label="Due, time"
              value={values.dueTime}
              onChange={(event) => set('dueTime')(event.target.value)}
              aria-invalid={errors.dueDate ? true : undefined}
            />
          </div>
        </Field>
        <Field id={id('followDate')} label="Follow-up" error={errors.followDate} hint="Without a time, 09:00.">
          <div className="desk-when">
            {input('followDate', { type: 'date' })}
            <input
              type="time"
              aria-label="Follow-up, time"
              value={values.followTime}
              onChange={(event) => set('followTime')(event.target.value)}
              aria-invalid={errors.followDate ? true : undefined}
            />
          </div>
        </Field>
      </div>
      {mode === 'edit' ? (
        <div className="desk-field">
          <Select label="Status" value={values.status} options={STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] }))} onChange={(value) => set('status')(value)} />
        </div>
      ) : null}
      <div className="desk-form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {busy ? 'Saving…' : mode === 'create' ? 'Create delegation' : 'Save changes'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// the create form in the details panel of the shell, for the page when the hash query has new=1.
export function NewDelegationPanel({ onDone, onCancel }: { onDone: (delegation: Delegation) => void; onCancel: () => void }) {
  return (
    <DetailsPanel title="New delegation" openKey="new" onClose={onCancel}>
      <DelegationForm mode="create" onDone={onDone} onCancel={onCancel} />
    </DetailsPanel>
  );
}
