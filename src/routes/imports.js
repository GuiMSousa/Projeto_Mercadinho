const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { z } = require('zod');

const prisma = require('../db');
const validate = require('../middleware/validate');
const httpError = require('../lib/httpError');
const { authenticate, authorize } = require('../middleware/auth');
const { toStoredDate } = require('../lib/calendar');
const { moveStock, expiryChange, setOpenBatchesExpiry } = require('../services/stockOps');
const { MAX_ROWS, MAX_COLUMNS, parseFile, parseDelimited } = require('../services/spreadsheet');
const { FIELDS, guessMapping, normalizeRow, nameKey } = require('../services/productImport');

const router = express.Router();
// Importar produtos reescreve preços e saldos em massa — é ação de dono, não de caixa.
router.use(authenticate, authorize('ADMIN'));

// A grade lida da planilha volta para o servidor a cada pré-visualização (o
// usuário pode trocar o mapeamento de colunas sem reenviar o arquivo), então
// este roteador aceita um corpo JSON maior que o padrão de 100kb do app.
router.use(express.json({ limit: '4mb' }));

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

const IMPORT_REASON = 'Importação de planilha';

// ---------- Schemas ----------

const cellSchema = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);

const mappingSchema = z.object(
  Object.fromEntries(FIELDS.map((f) => [f.key, z.number().int().min(0).max(MAX_COLUMNS - 1).optional()])),
);

const optionsSchema = z
  .object({
    mode: z.enum(['upsert', 'createOnly', 'updateOnly']).default('upsert'),
    matchBy: z.enum(['barcode', 'name']).default('barcode'),
    stockMode: z.enum(['ignore', 'set', 'add']).default('ignore'),
  })
  .default({});

const gridSchema = z.object({
  headers: z.array(z.string().max(200)).min(1).max(MAX_COLUMNS),
  rows: z.array(z.array(cellSchema).max(MAX_COLUMNS)).max(MAX_ROWS),
  mapping: mappingSchema,
  options: optionsSchema,
});

const pasteSchema = z.object({ text: z.string().min(1).max(2_000_000) });

// ---------- Análise ----------

function decimal(value, places) {
  return Number(value).toFixed(places);
}

// Monta o plano de importação: para cada linha, o que será feito (criar,
// atualizar, ignorar) e por quê. Nada é gravado aqui — é exatamente esta
// função que alimenta tanto a tela de conferência quanto a gravação, para que
// o que o usuário aprova seja literalmente o que acontece.
async function analyze({ rows, mapping, options }) {
  if (mapping.name === undefined) {
    throw httpError(400, 'Indique qual coluna da planilha tem o nome do produto.');
  }

  const [products, openBatches] = await Promise.all([
    prisma.product.findMany({
      select: {
        id: true, name: true, barcode: true, active: true,
        currentStock: true, costPrice: true, salePrice: true, minStock: true,
        unit: true, category: true, expiryDate: true,
      },
    }),
    prisma.stockBatch.findMany({ where: { remaining: { gt: 0 } }, select: { productId: true, expiryDate: true } }),
  ]);

  // Validades dos lotes com saldo, por produto — decidem se a validade da linha
  // pode ser aplicada ao produto inteiro (mesma regra da tela de produto).
  const openExpiries = new Map();
  for (const batch of openBatches) {
    if (!openExpiries.has(batch.productId)) openExpiries.set(batch.productId, []);
    openExpiries.get(batch.productId).push(batch.expiryDate);
  }

  const byBarcode = new Map();
  const byName = new Map();
  const ambiguousNames = new Set();
  for (const product of products) {
    if (product.barcode) byBarcode.set(product.barcode, product);
    const key = nameKey(product.name);
    if (byName.has(key)) ambiguousNames.add(key);
    else byName.set(key, product);
  }

  // Duplicatas dentro do próprio arquivo: sem isso, duas linhas do mesmo
  // produto viravam "criar" + "criar" (erro de chave única) ou, pior, uma
  // entrada de estoque contada duas vezes.
  const seenBarcodes = new Map();
  const seenNames = new Map();

  const items = rows.map((cells, index) => {
    const line = index + 2; // linha 1 é o cabeçalho
    const { values, errors, warnings } = normalizeRow(cells, mapping, options);
    const item = { line, values, errors: [...errors], warnings: [...warnings], action: 'error' };

    if (values.barcode) {
      const previous = seenBarcodes.get(values.barcode);
      if (previous) item.errors.push(`Código de barras repetido na linha ${previous} da planilha.`);
      else seenBarcodes.set(values.barcode, line);
    }
    if (values.name) {
      const key = nameKey(values.name);
      const previous = seenNames.get(key);
      if (previous && !values.barcode) item.errors.push(`Produto repetido na linha ${previous} da planilha.`);
      else if (!previous) seenNames.set(key, line);
    }

    if (item.errors.length > 0) return item;

    let match = null;
    if (options.matchBy === 'barcode' && values.barcode) {
      match = byBarcode.get(values.barcode) || null;
    }
    if (!match && values.name) {
      const key = nameKey(values.name);
      if (ambiguousNames.has(key)) {
        item.errors.push('Existe mais de um produto cadastrado com este nome — informe o código de barras para desfazer a ambiguidade.');
        return item;
      }
      const byNameMatch = byName.get(key) || null;
      // Casar pelo nome um produto que já tem OUTRO código de barras
      // gravado sobrescreveria esse código silenciosamente.
      if (byNameMatch && values.barcode && byNameMatch.barcode && byNameMatch.barcode !== values.barcode) {
        item.errors.push(`"${byNameMatch.name}" já está cadastrado com outro código de barras (${byNameMatch.barcode}).`);
        return item;
      }
      match = byNameMatch;
    }

    // O código de barras da linha pertence a um produto diferente daquele que
    // a linha identificou (ou a nenhum produto identificado). Gravar assim
    // violaria a chave única, ou — pior, quando a busca é por nome —
    // renomearia em silêncio o produto dono do código.
    if (values.barcode) {
      const owner = byBarcode.get(values.barcode);
      if (owner && (!match || owner.id !== match.id)) {
        item.errors.push(`O código de barras ${values.barcode} já pertence ao produto "${owner.name}".`);
        return item;
      }
    }

    if (match) {
      if (options.mode === 'createOnly') {
        item.action = 'skip';
        item.reason = 'Já cadastrado (modo "somente cadastrar novos").';
        return item;
      }
      item.action = 'update';
      item.productId = match.id;
      item.productName = match.name;
      if (!match.active) item.warnings.push('Produto está inativo — a importação atualiza os dados, mas ele segue fora das vendas.');

      const currentStock = Number(match.currentStock);
      item.before = {
        name: match.name,
        salePrice: Number(match.salePrice),
        costPrice: Number(match.costPrice),
        currentStock,
      };

      let delta = 0;
      if (values.stock !== undefined && options.stockMode === 'set') delta = values.stock - currentStock;
      else if (values.stock !== undefined && options.stockMode === 'add') delta = values.stock;

      if (delta !== 0) {
        const resulting = currentStock + delta;
        if (resulting < 0) {
          item.errors.push(`O estoque resultante ficaria negativo (${decimal(resulting, 3)}).`);
          return item;
        }
        item.stockDelta = delta;
        item.resultingStock = resulting;
      }

      // A validade vai para o lote novo quando a linha soma ao saldo; senão segue a
      // regra da tela de produto e, quando não dá para aplicar, só avisa.
      if (values.expiryDate !== undefined && !(item.stockDelta > 0)) {
        const change = expiryChange(match.expiryDate, openExpiries.get(match.id) ?? [], toStoredDate(values.expiryDate));
        if (change === 'apply') item.applyExpiry = true;
        else if (change === 'no-stock') item.warnings.push('Produto sem estoque: validade não aplicada (ela é registrada junto com uma entrada).');
        else if (change === 'mixed') item.warnings.push('Os lotes deste produto vencem em datas diferentes: validade não aplicada (corrija lote a lote).');
      }
      return item;
    }

    if (options.mode === 'updateOnly') {
      item.action = 'skip';
      item.reason = 'Não existe no cadastro (modo "somente atualizar existentes").';
      return item;
    }

    if (values.salePrice === undefined) {
      item.errors.push('Preço de venda é obrigatório para cadastrar um produto novo.');
      return item;
    }
    if (values.costPrice === undefined) {
      item.warnings.push('Sem preço de custo na planilha — será gravado como R$ 0,00.');
    }

    item.action = 'create';
    item.resultingStock = values.stock ?? 0;
    if (values.expiryDate && !(values.stock > 0)) {
      item.warnings.push('Sem estoque na linha: a validade só é registrada junto com estoque.');
    }
    return item;
  });

  const summary = { create: 0, update: 0, skip: 0, error: 0, total: items.length };
  for (const item of items) {
    if (item.errors.length > 0) item.action = 'error';
    summary[item.action] += 1;
  }

  return { summary, items };
}

// ---------- Rotas ----------

// Modelo de planilha pronto para preencher — resolve o "e como eu monto o
// arquivo?" sem o usuário ter que adivinhar nomes de coluna.
router.get('/products/template', async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Produtos');

  sheet.columns = [
    { header: 'Nome', key: 'name', width: 34 },
    { header: 'Código de barras', key: 'barcode', width: 20 },
    { header: 'Categoria', key: 'category', width: 18 },
    { header: 'Unidade', key: 'unit', width: 10 },
    { header: 'Preço de custo', key: 'costPrice', width: 16 },
    { header: 'Preço de venda', key: 'salePrice', width: 16 },
    { header: 'Estoque', key: 'stock', width: 12 },
    { header: 'Estoque mínimo', key: 'minStock', width: 16 },
    { header: 'Validade', key: 'expiryDate', width: 14 },
  ];
  sheet.getRow(1).font = { bold: true };

  sheet.addRow({ name: 'Arroz Tipo 1 5kg', barcode: '7891234567890', category: 'Mercearia', unit: 'PCT', costPrice: 18.9, salePrice: 24.9, stock: 40, minStock: 10, expiryDate: '31/12/2026' });
  sheet.addRow({ name: 'Leite Integral 1L', barcode: '7899876543210', category: 'Laticínios', unit: 'UN', costPrice: 3.75, salePrice: 5.49, stock: 60, minStock: 24, expiryDate: '30/06/2026' });

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-produtos.xlsx"');
  res.send(Buffer.from(buffer));
});

// Lê o arquivo (ou o texto colado) e devolve a grade + o palpite de quais
// colunas são quais campos. Não toca no banco.
router.post(
  '/products/parse',
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return next(httpError(400, `Arquivo maior que o limite de ${MAX_FILE_BYTES / 1024 / 1024} MB.`));
      return next(httpError(400, 'Não foi possível ler o arquivo enviado.'));
    });
  },
  async (req, res) => {
    let grid;
    if (req.file) {
      grid = await parseFile(req.file.buffer, req.file.originalname || '');
    } else {
      const parsed = pasteSchema.safeParse(req.body);
      if (!parsed.success) throw httpError(400, 'Envie um arquivo de planilha ou cole os dados copiados.');
      grid = parseDelimited(parsed.data.text);
    }

    res.json({ ...grid, mapping: guessMapping(grid.headers), fields: FIELDS });
  },
);

router.post('/products/preview', validate(gridSchema), async (req, res) => {
  res.json(await analyze(req.body));
});

router.post('/products/commit', validate(gridSchema), async (req, res) => {
  const plan = await analyze(req.body);
  const { stockMode } = req.body.options;
  const userId = req.user.sub;

  const result = { created: 0, updated: 0, skipped: plan.summary.skip, failed: 0, failures: [] };

  // Uma transação por linha (em vez de uma só para o arquivo inteiro): cada
  // produto entra completo — com sua movimentação de estoque — ou não entra,
  // e uma linha problemática no meio do arquivo não descarta as centenas que
  // já passaram. O relatório final diz exatamente quais falharam.
  for (const item of plan.items) {
    if (item.action !== 'create' && item.action !== 'update') continue;
    const { values } = item;

    try {
      if (item.action === 'create') {
        const initialStock = values.stock ?? 0;
        await prisma.$transaction(async (tx) => {
          const created = await tx.product.create({
            data: {
              name: values.name,
              barcode: values.barcode || null,
              category: values.category || null,
              unit: values.unit || 'UN',
              costPrice: decimal(values.costPrice ?? 0, 2),
              salePrice: decimal(values.salePrice, 2),
              minStock: decimal(values.minStock ?? 0, 3),
            },
          });
          if (initialStock > 0) {
            await moveStock(tx, {
              productId: created.id,
              quantity: initialStock,
              type: 'ENTRY',
              reason: `${IMPORT_REASON} (estoque inicial)`,
              userId,
              expiryDate: toStoredDate(values.expiryDate),
            });
          }
        });
        result.created += 1;
      } else {
        await prisma.$transaction(async (tx) => {
          await tx.product.update({
            where: { id: item.productId },
            data: {
              ...(values.name !== undefined && { name: values.name }),
              ...(values.barcode !== undefined && { barcode: values.barcode }),
              ...(values.category !== undefined && { category: values.category }),
              ...(values.unit !== undefined && { unit: values.unit }),
              ...(values.costPrice !== undefined && { costPrice: decimal(values.costPrice, 2) }),
              ...(values.salePrice !== undefined && { salePrice: decimal(values.salePrice, 2) }),
              ...(values.minStock !== undefined && { minStock: decimal(values.minStock, 3) }),
            },
          });

          // Aumento de saldo vira um lote com a validade da linha; redução baixa
          // pela ordem de perda do PVPS.
          if (item.stockDelta) {
            await moveStock(tx, {
              productId: item.productId,
              quantity: item.stockDelta,
              type: stockMode === 'add' ? 'ENTRY' : 'ADJUSTMENT',
              reason: stockMode === 'add' ? `${IMPORT_REASON} (entrada)` : `${IMPORT_REASON} (acerto de saldo)`,
              userId,
              expiryDate: toStoredDate(values.expiryDate),
              requireActive: false,
            });
          }
          if (item.applyExpiry) await setOpenBatchesExpiry(tx, item.productId, toStoredDate(values.expiryDate));
        });
        result.updated += 1;
      }
    } catch (err) {
      result.failed += 1;
      result.failures.push({
        line: item.line,
        name: values.name,
        // P2002 = violação de chave única; a análise já barra os casos
        // previsíveis, mas outra sessão pode ter cadastrado o mesmo código
        // de barras entre a conferência e a confirmação.
        error: err.code === 'P2002' ? 'Código de barras já cadastrado em outro produto.' : err.message || 'Falha ao gravar.',
      });
    }
  }

  res.json(result);
});

module.exports = router;
