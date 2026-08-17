// server.js — back-end do sorteio. Não usa nenhum gateway de pagamento:
// o Pix é o do próprio vendedor (chave estática). Este servidor só
// guarda e sincroniza os dados entre o cliente.html e o vendedor.html,
// e calcula os "centavos únicos" de cada venda pra ajudar a bater o
// extrato bancário.
//
// Requer Node.js 18+.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '6mb' })); // precisa de espaço pra imagem de comprovante em base64

const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULT_CONFIG = {
  prizeTitle: 'Honda Pop 2023 Branca',
  totalNumbers: 200,
  price: 25,
  drawDate: '',
  pixKey: '',
  nextCents: 1 // contador que gera o valor final único (ex: 25,01 / 25,02 / 25,03...)
};

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { config: { ...DEFAULT_CONFIG }, tickets: {}, sales: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      config: { ...DEFAULT_CONFIG, ...(parsed.config || {}) },
      tickets: parsed.tickets || {},
      sales: parsed.sales || {}
    };
  } catch (e) {
    console.error('Falha ao ler data.json, iniciando do zero.', e);
    return { config: { ...DEFAULT_CONFIG }, tickets: {}, sales: {} };
  }
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();

function nextUniqueCents() {
  const c = data.config.nextCents;
  data.config.nextCents = c >= 99 ? 1 : c + 1;
  return c;
}

// -------- rotas usadas pelo cliente.html --------

// estado público: config + status dos números (sem dados pessoais)
app.get('/api/state', (req, res) => {
  res.json({ config: data.config, tickets: data.tickets });
});

// passo 1: reserva os números e gera o valor exato (com centavos únicos) a pagar
app.post('/api/sale', (req, res) => {
  const { buyerName, buyerPhone, numbers } = req.body;
  if (!buyerName || !buyerPhone || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'Dados incompletos.' });
  }
  for (const n of numbers) {
    if (data.tickets[n]) {
      return res.status(409).json({ error: `O número ${n} não está mais disponível.` });
    }
  }
  const baseTotal = numbers.length * data.config.price;
  const cents = nextUniqueCents();
  const total = Math.floor(baseTotal) + cents / 100;
  const saleId = 'S' + Date.now() + Math.random().toString(36).slice(2, 6);

  data.sales[saleId] = {
    id: saleId, buyerName, buyerPhone, numbers,
    baseTotal, uniqueCents: cents, total,
    proofCode: '', receiptImage: '',
    status: 'reservado', // reservado -> aguardando (comprovante enviado) -> pago
    createdAt: Date.now()
  };
  numbers.forEach(n => { data.tickets[n] = { status: 'reservado', saleId, buyerName, buyerPhone }; });
  saveData();

  res.json({ saleId, total, pixKey: data.config.pixKey, prizeTitle: data.config.prizeTitle });
});

// passo 2: comprador envia código de autenticação e/ou comprovante
app.post('/api/sale/:id/comprovante', (req, res) => {
  const sale = data.sales[req.params.id];
  if (!sale) return res.status(404).json({ error: 'Venda não encontrada.' });
  const { proofCode, receiptImage } = req.body;
  const code = (proofCode || '').trim();
  const image = receiptImage || '';
  if (!code && !image) {
    return res.status(400).json({ error: 'Informe o código de autenticação do Pix ou anexe o comprovante.' });
  }
  sale.proofCode = code;
  sale.receiptImage = image;
  sale.status = 'aguardando'; // aguardando conferência do vendedor
  sale.numbers.forEach(n => { if (data.tickets[n]) data.tickets[n].status = 'aguardando'; });
  saveData();
  res.json({ ok: true });
});

app.get('/api/sale/:id/status', (req, res) => {
  const sale = data.sales[req.params.id];
  if (!sale) return res.status(404).json({ error: 'Venda não encontrada (pode ter sido cancelada).' });
  res.json({ status: sale.status, numbers: sale.numbers, total: sale.total });
});

app.post('/api/sale/:id/cancelar', (req, res) => {
  const sale = data.sales[req.params.id];
  if (!sale) return res.status(404).json({ error: 'Venda não encontrada.' });
  if (sale.status === 'pago') return res.status(400).json({ error: 'Venda já paga — cancele pelo painel do vendedor.' });
  sale.numbers.forEach(n => delete data.tickets[n]);
  delete data.sales[req.params.id];
  saveData();
  res.json({ ok: true });
});

// -------- rotas usadas pelo vendedor.html --------

app.get('/api/sales', (req, res) => {
  res.json({ sales: data.sales, config: data.config });
});

app.post('/api/config', (req, res) => {
  const { prizeTitle, totalNumbers, price, drawDate, pixKey } = req.body;
  if (!totalNumbers || totalNumbers < 1 || price == null || price < 0) {
    return res.status(400).json({ error: 'Valores inválidos.' });
  }
  data.config = {
    ...data.config,
    prizeTitle: prizeTitle || DEFAULT_CONFIG.prizeTitle,
    totalNumbers, price, drawDate: drawDate || '', pixKey: pixKey || ''
  };
  saveData();
  res.json({ ok: true, config: data.config });
});

// vendedor confere o extrato/comprovante e confirma manualmente
app.post('/api/sale/:id/confirmar', (req, res) => {
  const sale = data.sales[req.params.id];
  if (!sale) return res.status(404).json({ error: 'Venda não encontrada.' });
  sale.status = 'pago';
  sale.numbers.forEach(n => { if (data.tickets[n]) data.tickets[n].status = 'pago'; });
  saveData();
  res.json({ ok: true });
});

app.post('/api/sale/:id/estornar', (req, res) => {
  const sale = data.sales[req.params.id];
  if (!sale) return res.status(404).json({ error: 'Venda não encontrada.' });
  sale.numbers.forEach(n => delete data.tickets[n]);
  delete data.sales[req.params.id];
  saveData();
  res.json({ ok: true });
});

app.get('/', (req, res) => res.send('Servidor do sorteio rodando. Use /api/state para testar.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
