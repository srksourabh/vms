import React, { useState } from 'react';
import type { IdScanResult } from './idScanTypes';

const ID_TYPES = ['Aadhaar', 'PAN', 'Voter ID', 'Driver Licence', 'Passport'] as const;
type IdTypeLabel = (typeof ID_TYPES)[number];

type Props = {
  onSubmit: (result: IdScanResult) => void;
};

function last4Ok(value: string): boolean {
  return /^[A-Za-z0-9]{4}$/.test(value);
}

/** When on-device OCR cannot read the card, the guard still has the document
 *  in hand. They record the type, the last four (the only digits we store),
 *  and the name as printed so Check In is not blocked by a lighting failure. */
export default function ManualIdEntry({ onSubmit }: Props): React.ReactElement {
  const [idType, setIdType] = useState<IdTypeLabel>('Aadhaar');
  const [last4, setLast4] = useState('');
  const [name, setName] = useState('');

  const last4Bad = last4.length > 0 && !last4Ok(last4);
  const nameTrim = name.trim();
  const blocked = !last4Ok(last4) || nameTrim.length < 2;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (blocked) return;
    const digits = last4.toUpperCase();
    onSubmit({
      idType,
      idLast4: digits,
      name: nameTrim,
      masked: `XXXX${digits}`,
      dateOfBirth: null,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-surface-200 p-3.5">
      <p className="text-sm font-bold text-navy-800">Enter details from the card</p>
      <p className="text-[11px] text-navy-700">
        Use this when the scan cannot read the document. Only the last four characters are stored.
      </p>
      <label className="block">
        <span className="label">Document</span>
        <select
          className="input w-full"
          value={idType}
          onChange={(e) => setIdType(e.target.value as IdTypeLabel)}
        >
          {ID_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="label">Last 4 of ID number *</span>
        <input
          className="input w-full font-mono"
          value={last4}
          onChange={(e) => setLast4(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 4))}
          placeholder="e.g. 9012"
          maxLength={4}
          autoComplete="off"
          aria-invalid={last4Bad}
        />
      </label>
      <label className="block">
        <span className="label">Name as printed *</span>
        <input
          className="input w-full"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="As on the ID card"
          autoComplete="off"
        />
      </label>
      <button type="submit" disabled={blocked} className="btn-primary w-full py-2.5 text-sm disabled:opacity-50">
        Use these details
      </button>
    </form>
  );
}
