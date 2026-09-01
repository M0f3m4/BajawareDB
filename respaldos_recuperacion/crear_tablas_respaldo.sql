-- ============================================================
-- CREAR TABLAS DE RESPALDO AUTOMÁTICO — correr UNA SOLA VEZ
-- (con un usuario con permisos DDL, p. ej. desde SSMS)
--
-- La app llenará estas tablas sola:
--   · Foto DIARIA de cada tabla (retención 30 días, purga automática)
--   · Foto PRE_CARGA de las claves afectadas antes de cada carga Excel
-- ============================================================

-- El UNION ALL es a propósito: evita que se copie la propiedad
-- IDENTITY del ID (si se copiara, la app no podría insertar los IDs).

-- 1) ESTATUS_REPORTE_RESPALDO
SELECT TOP 0 * INTO ESTATUS_REPORTE_RESPALDO
FROM ESTATUS_REPORTE
UNION ALL SELECT TOP 0 * FROM ESTATUS_REPORTE;

ALTER TABLE ESTATUS_REPORTE_RESPALDO ADD
  FECHA_RESPALDO   DATETIME     NOT NULL DEFAULT GETDATE(),
  MOTIVO           VARCHAR(200) NULL,
  USUARIO_RESPALDO VARCHAR(100) NULL;

CREATE INDEX IX_ER_RESP_FECHA ON ESTATUS_REPORTE_RESPALDO (FECHA_RESPALDO);

-- 2) INVENTARIO_REPORTES_RESPALDO
SELECT TOP 0 * INTO INVENTARIO_REPORTES_RESPALDO
FROM INVENTARIO_REPORTES
UNION ALL SELECT TOP 0 * FROM INVENTARIO_REPORTES;

ALTER TABLE INVENTARIO_REPORTES_RESPALDO ADD
  FECHA_RESPALDO   DATETIME     NOT NULL DEFAULT GETDATE(),
  MOTIVO           VARCHAR(200) NULL,
  USUARIO_RESPALDO VARCHAR(100) NULL;

CREATE INDEX IX_IR_RESP_FECHA ON INVENTARIO_REPORTES_RESPALDO (FECHA_RESPALDO);

-- Verificación
SELECT 'ESTATUS_REPORTE_RESPALDO' AS tabla, COUNT(*) AS filas FROM ESTATUS_REPORTE_RESPALDO
UNION ALL
SELECT 'INVENTARIO_REPORTES_RESPALDO', COUNT(*) FROM INVENTARIO_REPORTES_RESPALDO;
-- Debe regresar 0 y 0 (vacías); la app las llena sola al arrancar.

-- ============================================================
-- CÓMO CONSULTAR / RESTAURAR (referencia, no correr ahora)
-- ============================================================
-- Ver qué fotos hay:
--   SELECT MOTIVO, FECHA_RESPALDO, USUARIO_RESPALDO, COUNT(*) AS filas
--   FROM ESTATUS_REPORTE_RESPALDO
--   GROUP BY MOTIVO, FECHA_RESPALDO, USUARIO_RESPALDO
--   ORDER BY FECHA_RESPALDO DESC;
--
-- Ver cómo estaba una fila antes de una carga:
--   SELECT * FROM ESTATUS_REPORTE_RESPALDO
--   WHERE CLAVE_REP = 'MX_...' ORDER BY FECHA_RESPALDO DESC;
--
-- Restaurar un campo planchado (ejemplo VERSION_CARGA):
--   UPDATE er SET er.VERSION_CARGA = r.VERSION_CARGA
--   FROM ESTATUS_REPORTE er
--   JOIN ESTATUS_REPORTE_RESPALDO r ON r.ID_ESTATUS_REP = er.ID_ESTATUS_REP
--   WHERE r.FECHA_RESPALDO = '<fecha de la foto>' AND er.CLAVE_REP = 'MX_...';
