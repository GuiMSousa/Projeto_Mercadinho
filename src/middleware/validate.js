// Middleware genérico de validação com Zod. Nunca confia em req.body/query/params
// "crus": troca-os pelo resultado já validado e tipado (schema.parse), então
// handlers nunca leem entrada não validada.
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return res.status(400).json({
        error: 'Dados inválidos.',
        details: result.error.flatten(),
      });
    }
    req[source] = result.data;
    next();
  };
}

module.exports = validate;
