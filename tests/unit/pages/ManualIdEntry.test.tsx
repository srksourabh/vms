import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ManualIdEntry from '../../../src/pages/Guard/ManualIdEntry';

afterEach(() => cleanup());

describe('ManualIdEntry', () => {
  it('heading names the fallback', () => {
    render(<ManualIdEntry onSubmit={vi.fn()} />);
    expect(screen.getByText('Enter details from the card')).toBeInTheDocument();
  });

  it('empty state keeps Use these details disabled', () => {
    render(<ManualIdEntry onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Use these details/i })).toBeDisabled();
  });

  it('submits type, last four and printed name — never a full ID number', () => {
    const onSubmit = vi.fn();
    render(<ManualIdEntry onSubmit={onSubmit} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'PAN' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 9012'), { target: { value: '234F' } });
    fireEvent.change(screen.getByPlaceholderText('As on the ID card'), { target: { value: 'Rahul Menon' } });
    fireEvent.click(screen.getByRole('button', { name: /Use these details/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      idType: 'PAN',
      idLast4: '234F',
      name: 'Rahul Menon',
      masked: 'XXXX234F',
      dateOfBirth: null,
    });
    expect(JSON.stringify(onSubmit.mock.calls[0][0])).not.toMatch(/ABCDE/i);
  });

  it('strips punctuation from last-4 and refuses fewer than four characters', () => {
    const onSubmit = vi.fn();
    render(<ManualIdEntry onSubmit={onSubmit} />);
    fireEvent.change(screen.getByPlaceholderText('e.g. 9012'), { target: { value: '12-3' } });
    fireEvent.change(screen.getByPlaceholderText('As on the ID card'), { target: { value: 'Rahul Menon' } });
    expect(screen.getByRole('button', { name: /Use these details/i })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
