import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { networkInterfaces } from 'node:os';
import { SerialTransport, parseSerialAddress } from '../src/services/printing/serial.ts';
import type { PsRequest, PsResult } from '../src/services/printing/powershell.ts';
import type { PrinterRow } from '../src/services/printing/transports.ts';
import { candidateHosts, classifyPort, listSerialPorts, listWindowsPrinters, scanHosts } from '../src/services/printing/devices.ts';

const btPrinter = (address: string | null = 'COM5', profile = 'generic'): PrinterRow => ({ id: 'bt1', name: 'BT', transport: 'serial', address, width_mm: 58, profile, raster: 0, is_receipt: 1, drawer: 0, stations: '[]', active: 1 });
function fakePs(answer: (r: PsRequest) => PsResult) {
  const calls: PsRequest[] = [];
  return { calls, run: async (r: PsRequest) => { calls.push(r); return answer(r); } };
}

// ---------- Bluetooth / serial printers ----------

test('serial (Bluetooth) addresses: COM port with an optional baud rate; anything else is refused', () => {
  assert.deepEqual(parseSerialAddress('COM5'), { port: 'COM5', baud: 9600 });
  assert.deepEqual(parseSerialAddress(' com12:115200 '), { port: 'COM12', baud: 115200 });
  for (const bad of ['', 'COM0', 'COM1000', 'COM5:1234', 'LPT1', '\\\\.\\COM5', 'COM5;calc', '/dev/ttyUSB0']) assert.equal(parseSerialAddress(bad), null, bad);
});

test('serial transport: sends the exact bytes to the COM port in printer-sized chunks; errors become plain language', async () => {
  const ok = fakePs((r) => ({ code: 0, stdout: `OK ${Buffer.from(r.stdin!, 'base64').length}`, stderr: '' }));
  const payload = Uint8Array.from({ length: 3000 }, (_, i) => i % 256);
  await new SerialTransport({ platform: 'win32', run: ok.run }).send(btPrinter('COM7:19200', 'slow_buffer'), payload);
  const call = ok.calls[0]!;
  assert.deepEqual(Buffer.from(call.stdin!, 'base64'), Buffer.from(payload));
  assert.deepEqual([call.env!.POS_SERIAL_PORT, call.env!.POS_SERIAL_BAUD, call.env!.POS_SERIAL_CHUNK], ['COM7', '19200', '256']);
  assert.ok(!call.script.includes('COM7'), 'the port name never goes into the script');

  const cases: Array<[PsResult, RegExp]> = [
    [{ code: 1, stdout: 'ERR open IOException', stderr: '' }, /COM5 was not found.*paired/],
    [{ code: 1, stdout: 'ERR open UnauthorizedAccessException', stderr: '' }, /in use by another program/],
    [{ code: 1, stdout: 'ERR write TimeoutException', stderr: '' }, /did not accept the data in time/],
    [{ code: 1, stdout: 'ERR timeout', stderr: '' }, /did not accept the data in time/],
    [{ code: null, stdout: '', stderr: '', timedOut: true }, /did not accept the data in time/],
    [{ code: 0, stdout: 'OK 2', stderr: '' }, /accepted 2 of 3 bytes/],
    [{ code: 1, stdout: '', stderr: 'boom\r\nat line 3' }, /could not start the Windows print helper/],
  ];
  for (const [answer, re] of cases) {
    const t = new SerialTransport({ platform: 'win32', run: async () => answer });
    await assert.rejects(t.send(btPrinter(), new Uint8Array(3)), (e: Error) => { assert.match(e.message, re); assert.ok(!/\r|\n/.test(e.message)); return true; });
  }
  const none = fakePs(() => ({ code: 0, stdout: 'OK 0', stderr: '' }));
  await assert.rejects(new SerialTransport({ platform: 'win32', run: none.run }).send(btPrinter('COM5;calc'), new Uint8Array(1)), /COM port/);
  await assert.rejects(new SerialTransport({ platform: 'linux', run: none.run }).send(btPrinter(), new Uint8Array(1)), /only available on Windows/);
  assert.equal(none.calls.length, 0);
});

test('real Windows: a COM port that does not exist is reported as not found (nothing is sent anywhere)', { skip: process.platform !== 'win32' && 'Windows only', timeout: 60_000 }, async () => {
  await assert.rejects(new SerialTransport().send(btPrinter('COM199'), new Uint8Array([0x1b, 0x40])), /COM199 was not found/);
});

// ---------- finding printers ----------

test('installed Windows printers: parsed and labelled USB, network, Bluetooth or virtual', async () => {
  assert.equal(classifyPort('USB001'), 'usb');
  assert.equal(classifyPort('COM5:'), 'serial');
  assert.equal(classifyPort('IP_192.168.1.40'), 'network');
  assert.equal(classifyPort('192.168.1.40'), 'network');
  assert.equal(classifyPort('WSD-1234-abcd'), 'network');
  assert.equal(classifyPort('BTH001'), 'bluetooth');
  assert.equal(classifyPort('PORTPROMPT:'), 'virtual');
  assert.equal(classifyPort('nul:'), 'virtual');
  assert.equal(classifyPort('C:\\out\\file.pdf'), 'virtual');
  const one = fakePs(() => ({ code: 0, stdout: '[{"Name":"EPSON TM-T82","PortName":"USB001","DriverName":"EPSON TM-T82 Receipt","WorkOffline":false}]', stderr: '' }));
  assert.deepEqual(await listWindowsPrinters({ platform: 'win32', run: one.run }), [{ name: 'EPSON TM-T82', port: 'USB001', driver: 'EPSON TM-T82 Receipt', offline: false, connection: 'usb' }]);
  const single = fakePs(() => ({ code: 0, stdout: '{"Name":"POS-58","PortName":"BTH002","DriverName":"Generic / Text Only","WorkOffline":true}', stderr: '' }));
  assert.equal((await listWindowsPrinters({ platform: 'win32', run: single.run }))[0]!.connection, 'bluetooth');
  assert.deepEqual(await listWindowsPrinters({ platform: 'linux', run: one.run }), []);
  await assert.rejects(listWindowsPrinters({ platform: 'win32', run: async () => ({ code: 1, stdout: '', stderr: 'x' }) }), /could not list/);
});

test('COM ports: Bluetooth links are recognised by their device id and sorted by number', async () => {
  const ps = fakePs(() => ({ code: 0, stdout: '[{"Name":"Standard Serial over Bluetooth link (COM6)","Id":"BTHENUM\\\\{0000}_LOCALMFG"},{"Name":"Communications Port (COM1)","Id":"ACPI\\\\PNP0501\\\\0"},{"Name":"","Id":"","Port":"COM12"}]', stderr: '' }));
  assert.deepEqual(await listSerialPorts({ platform: 'win32', run: ps.run }), [
    { port: 'COM1', name: 'Communications Port (COM1)', bluetooth: false },
    { port: 'COM6', name: 'Standard Serial over Bluetooth link (COM6)', bluetooth: true },
    { port: 'COM12', name: 'COM12', bluetooth: false },
  ]);
});

test('real Windows: listing installed printers and COM ports works (read only)', { skip: process.platform !== 'win32' && 'Windows only', timeout: 60_000 }, async () => {
  const list = await listWindowsPrinters();
  assert.ok(Array.isArray(list));
  for (const p of list) assert.ok(typeof p.name === 'string' && p.name.length > 0 && ['usb', 'serial', 'bluetooth', 'network', 'virtual', 'other'].includes(p.connection));
  assert.ok(Array.isArray(await listSerialPorts()));
});

test('Wi-Fi / LAN scan: only private /24 neighbours are probed, and a printer port that answers is found', async () => {
  const ifaces = {
    wifi: [{ address: '192.168.1.37', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '192.168.1.37/24', mac: '' }],
    loop: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, cidr: '127.0.0.1/8', mac: '' }],
    pub: [{ address: '8.8.4.4', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '8.8.4.4/24', mac: '' }],
    big: [{ address: '10.20.30.40', netmask: '255.0.0.0', family: 'IPv4', internal: false, cidr: '10.20.30.40/8', mac: '' }],
    v6: [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, cidr: 'fe80::1/64', mac: '', scopeid: 1 }],
  } as unknown as ReturnType<typeof networkInterfaces>;
  const hosts = candidateHosts(ifaces);
  assert.equal(hosts.length, 253 + 253); // 192.168.1.x and 10.20.30.x (only the own /24 of a big network), own address excluded
  assert.ok(!hosts.includes('192.168.1.37') && hosts.includes('192.168.1.1') && hosts.includes('10.20.30.254') && !hosts.some((h) => h.startsWith('8.8.')));
  assert.ok(!hosts.includes('192.168.1.0') && !hosts.includes('192.168.1.255'));

  const srv = net.createServer((s) => s.end());
  const port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as net.AddressInfo).port)));
  try {
    assert.deepEqual(await scanHosts(['127.0.0.1', '127.0.0.2', '127.0.0.3'], port, 300), ['127.0.0.1']);
  } finally { srv.close(); }
});
