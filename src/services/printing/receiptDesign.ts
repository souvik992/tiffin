import { AppError, get, run } from '../../store/db.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { runCommand } from '../commands.ts';
import { audit } from '../audit.ts';
import { assertPerm } from '../permissions.ts';
import { getSetting, loadSettings, setSetting } from '../settings.ts';
import { buildReceipt, sampleReceiptData } from './receipt.ts';
import type { ReceiptData } from './receipt.ts';
import { parseTemplate, TEMPLATE_EXT } from './receiptTemplate.ts';
import type { ReceiptTemplate } from './receiptTemplate.ts';
import { colsFor } from './transports.ts';
import { storeLogo } from '../store.ts';
import { parseEscPos } from './virtual.ts';

/**
 * The shop's receipt design (Settings > Receipt): an uploaded .tiffinreceipt file, checked before it is saved.
 * Stored in settings (so backups and restores carry it). Printing never fails because of a design: if a stored
 * design ever stops parsing (for example after an update), bills print in the standard layout and a warning is logged.
 */

const KEY = 'receipt_template';
const META = 'receipt_template_meta';
export const DESIGN_KEYS = [KEY, META];

export interface DesignMeta { name: string; description: string | null; fileName: string; uploadedAt: number; uploadedBy: string }

let cache: { text: string; template: ReceiptTemplate | null } | null = null;

/** The active design, or null for the standard layout. */
export function activeTemplate(ctx: Ctx): ReceiptTemplate | null {
  const text = getSetting(ctx, KEY);
  if (!text) return null;
  if (cache?.text === text) return cache.template;
  const r = parseTemplate(text);
  if (!r.ok) ctx.logger.warn('stored receipt design no longer valid; printing the standard layout', { errors: r.errors.slice(0, 3) });
  cache = { text, template: r.ok ? r.template : null };
  return cache.template;
}

/** Options every receipt build shares: the design and the UPI id for its QR code. */
export function designOptions(ctx: Ctx): { template: ReceiptTemplate | null; upiId: string; logo: ReturnType<typeof storeLogo> } {
  return { template: activeTemplate(ctx), upiId: loadSettings(ctx).upiId, logo: storeLogo(ctx) };
}

export function getReceiptDesign(ctx: Ctx, actor: Actor) {
  assertPerm(actor, 'printer.manage');
  const meta = getSetting(ctx, META);
  const active = activeTemplate(ctx);
  return { active: meta && active ? (JSON.parse(meta) as DesignMeta) : null, extension: TEMPLATE_EXT };
}

function outletOf(ctx: Ctx): ReceiptData['outlet'] {
  const o = get<{ name: string; address: string | null; gstin: string | null; fssai_no: string | null; phone: string | null }>(ctx.db, 'SELECT name, address, gstin, fssai_no, phone FROM outlet LIMIT 1');
  return { name: o?.name ?? 'Your shop name', address: o?.address ?? null, gstin: o?.gstin ?? null, fssaiNo: o?.fssai_no ?? null, phone: o?.phone ?? null };
}

function checkFile(fileName: string, content: string): ReceiptTemplate {
  if (!fileName.toLowerCase().endsWith(TEMPLATE_EXT)) throw new AppError('VALIDATION', `Choose a receipt design file (its name ends in ${TEMPLATE_EXT}).`, 400, { errors: [`The file must end in ${TEMPLATE_EXT}.`] });
  const r = parseTemplate(content);
  if (!r.ok) throw new AppError('VALIDATION', 'This receipt design cannot be used.', 400, { errors: r.errors });
  return r.template;
}

/** Checks a design file and shows the sample bill it would print, without saving anything. */
export function previewReceiptDesign(ctx: Ctx, actor: Actor, input: { fileName: string; content: string; widthMm: number }) {
  assertPerm(actor, 'settings.write');
  if (input.widthMm !== 58 && input.widthMm !== 80) throw new AppError('VALIDATION', 'Paper width must be 58 or 80 mm.');
  const template = checkFile(input.fileName, input.content);
  const cols = colsFor(input.widthMm);
  const bytes = buildReceipt(sampleReceiptData(outletOf(ctx), ctx.clock.now()), { cols, copyNo: 1, footer: loadSettings(ctx).receiptFooter, drawer: false, sample: true, template, upiId: loadSettings(ctx).upiId, logo: storeLogo(ctx) });
  return { name: template.name, description: template.description ?? null, widthMm: input.widthMm, cols, lines: parseEscPos(bytes, { widen: true }).lines };
}

/** Makes the design the one every new bill prints with (owner only). */
export function setReceiptDesign(ctx: Ctx, actor: Actor, requestId: string, input: { fileName: string; content: string }) {
  return runCommand(ctx, requestId, 'receipt.design.set', actor, () => {
    assertPerm(actor, 'settings.write');
    const template = checkFile(input.fileName, input.content);
    const fileName = input.fileName.split(/[\\/]/).pop()!.slice(0, 120);
    const meta: DesignMeta = { name: template.name, description: template.description ?? null, fileName, uploadedAt: ctx.clock.now(), uploadedBy: actor.userId };
    setSetting(ctx, KEY, input.content.replace(/^﻿/, ''));
    setSetting(ctx, META, JSON.stringify(meta));
    audit(ctx, actor.userId, 'receipt.design.set', 'settings', KEY, { name: template.name, fileName });
    return { active: meta };
  });
}

/** Back to the standard layout (owner only). */
export function clearReceiptDesign(ctx: Ctx, actor: Actor, requestId: string) {
  return runCommand(ctx, requestId, 'receipt.design.clear', actor, () => {
    assertPerm(actor, 'settings.write');
    run(ctx.db, 'DELETE FROM settings WHERE key IN (?, ?)', KEY, META);
    audit(ctx, actor.userId, 'receipt.design.clear', 'settings', KEY);
    return { active: null };
  });
}
