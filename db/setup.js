/**
 * db/setup.js
 * Crea tablas necesarias si no existen.
 * Ejecutar una vez con: node db/setup.js
 * O se llama automáticamente desde server.js al arrancar.
 */

require('dotenv').config();
const { query } = require('./connection');

async function setup() {
  console.log('🔧 Verificando / creando tablas...');

  // ── LAYOUT_VERSIONES ──────────────────────────────────────
  // Versión semántica (MAJOR.MINOR.PATCH) vinculada a tickets Jira QD/CDL
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'LAYOUT_VERSIONES'
    )
    BEGIN
      CREATE TABLE LAYOUT_VERSIONES (
        ID_VERSION         INT IDENTITY(1,1) PRIMARY KEY,

        -- Layout afectado
        CLAVE_LAYOUT       VARCHAR(60)   NOT NULL,

        -- Versión semántica
        VER_MAJOR          INT           NOT NULL DEFAULT 1,
        VER_MINOR          INT           NOT NULL DEFAULT 0,
        VER_PATCH          INT           NOT NULL DEFAULT 0,
        VERSION_SEM        AS (CAST(VER_MAJOR AS VARCHAR) + '.' +
                               CAST(VER_MINOR AS VARCHAR) + '.' +
                               CAST(VER_PATCH AS VARCHAR)) PERSISTED,

        -- Nivel de cambio detectado
        -- 'MAJOR' = campos nuevos/eliminados
        -- 'MINOR' = tipo, obligatorio, llave, validacion cambiaron
        -- 'PATCH' = descripcion, formato, catalogo cambiaron
        NIVEL_CAMBIO       VARCHAR(10)   NOT NULL DEFAULT 'PATCH'
                           CHECK (NIVEL_CAMBIO IN ('MAJOR','MINOR','PATCH')),

        -- Ticket Jira que originó el cambio
        JIRA_TICKET        VARCHAR(30)   NULL,    -- ej. QD-42, CDL-15
        JIRA_STATUS        VARCHAR(60)   NULL,    -- ej. Instalados en QA
        JIRA_SUMMARY       VARCHAR(500)  NULL,

        -- Archivo fuente
        ARCHIVO_NOMBRE     VARCHAR(255)  NOT NULL,

        -- Estadísticas del procesamiento
        FILAS_PROCESADAS   INT           NOT NULL DEFAULT 0,
        CAMPOS_NUEVOS      INT           NOT NULL DEFAULT 0,
        CAMPOS_ACTUALIZADOS INT          NOT NULL DEFAULT 0,
        CAMPOS_ELIMINADOS  INT           NOT NULL DEFAULT 0,

        -- Auditoría
        USUARIO            VARCHAR(100)  NOT NULL,
        FECHA_CARGA        DATETIME      NOT NULL DEFAULT GETDATE(),
        NOTAS              VARCHAR(1000) NULL
      )

      -- Índices útiles
      CREATE INDEX IX_LV_LAYOUT  ON LAYOUT_VERSIONES (CLAVE_LAYOUT)
      CREATE INDEX IX_LV_TICKET  ON LAYOUT_VERSIONES (JIRA_TICKET)
      CREATE INDEX IX_LV_FECHA   ON LAYOUT_VERSIONES (FECHA_CARGA DESC)

      PRINT 'Tabla LAYOUT_VERSIONES creada.'
    END
    ELSE
      PRINT 'Tabla LAYOUT_VERSIONES ya existe.'
  `);

  // ── QA_ALERTAS ────────────────────────────────────────────
  // Tickets QD/CDL detectados en "Instalados en QA" pendientes de procesar
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'QA_ALERTAS'
    )
    BEGIN
      CREATE TABLE QA_ALERTAS (
        ID_ALERTA          INT IDENTITY(1,1) PRIMARY KEY,
        JIRA_TICKET        VARCHAR(30)   NOT NULL,
        JIRA_PROJECT       VARCHAR(20)   NOT NULL,   -- QD o CDL
        JIRA_SUMMARY       VARCHAR(500)  NULL,
        JIRA_STATUS        VARCHAR(60)   NULL,
        JIRA_UPDATED       DATETIME      NULL,
        JIRA_ASSIGNEE      VARCHAR(100)  NULL,

        -- Layout detectado automáticamente (puede ser NULL si no se detectó)
        CLAVE_LAYOUT_DETECTADO VARCHAR(60) NULL,
        LAYOUT_CONFIRMADO  BIT           NOT NULL DEFAULT 0,
        CLAVE_LAYOUT_FINAL VARCHAR(60)   NULL,       -- el que confirmó el usuario

        -- Estado de la alerta
        -- PENDIENTE → esperando que suban Excel
        -- PROCESADO → ya se subió Excel y se generó versión
        -- IGNORADO  → el usuario decidió ignorarla
        ESTADO             VARCHAR(20)   NOT NULL DEFAULT 'PENDIENTE'
                           CHECK (ESTADO IN ('PENDIENTE','PROCESADO','IGNORADO')),

        ID_VERSION_GENERADA INT          NULL,        -- FK a LAYOUT_VERSIONES
        FECHA_DETECTADO    DATETIME      NOT NULL DEFAULT GETDATE(),
        FECHA_PROCESADO    DATETIME      NULL,
        PROCESADO_POR      VARCHAR(100)  NULL
      )

      CREATE UNIQUE INDEX IX_QA_TICKET ON QA_ALERTAS (JIRA_TICKET)
      CREATE INDEX IX_QA_ESTADO       ON QA_ALERTAS (ESTADO)

      PRINT 'Tabla QA_ALERTAS creada.'
    END
    ELSE
      PRINT 'Tabla QA_ALERTAS ya existe.'
  `);

  // ── SOFIPO_LAYOUT_DESC ────────────────────────────────────
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'SOFIPO_LAYOUT_DESC'
    )
    BEGIN
      CREATE TABLE SOFIPO_LAYOUT_DESC (
        ID               INT IDENTITY(1,1) PRIMARY KEY,
        EMPRESA          VARCHAR(20)   NULL,
        PAIS             VARCHAR(10)   NULL,
        CLAVE_LAYOUT     VARCHAR(100)  NOT NULL,
        ORDEN            INT           NULL,
        LLAVE            VARCHAR(10)   NULL,
        NOMBRE_CAMPO     VARCHAR(200)  NOT NULL,
        TIPO_DATO        VARCHAR(50)   NULL,
        FORMATO          VARCHAR(100)  NULL,
        OBLIGATORIO      VARCHAR(10)   NULL,
        VALIDACION       VARCHAR(500)  NULL,
        CATALOGO         VARCHAR(200)  NULL,
        DESCRIPCION      VARCHAR(1000) NULL,
        DESCRIPCION_EN   VARCHAR(1000) NULL,
        OBSERVACIONES    VARCHAR(1000) NULL,
        VALIDEZ_INFO     VARCHAR(500)  NULL,
        FUENTE           VARCHAR(200)  NULL,
        FECHA_CARGA      DATETIME      NOT NULL DEFAULT GETDATE()
      )
      CREATE INDEX IX_SLD_LAYOUT ON SOFIPO_LAYOUT_DESC (CLAVE_LAYOUT)
      CREATE INDEX IX_SLD_CAMPO  ON SOFIPO_LAYOUT_DESC (NOMBRE_CAMPO)
      PRINT 'Tabla SOFIPO_LAYOUT_DESC creada.'
    END
    ELSE PRINT 'Tabla SOFIPO_LAYOUT_DESC ya existe.'
  `);

  // ── SOFIPO_LAYOUT_USO ─────────────────────────────────────
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'SOFIPO_LAYOUT_USO'
    )
    BEGIN
      CREATE TABLE SOFIPO_LAYOUT_USO (
        ID               INT IDENTITY(1,1) PRIMARY KEY,
        EMPRESA          VARCHAR(20)   NULL,
        PAIS             VARCHAR(10)   NULL,
        CLAVE_LAYOUT     VARCHAR(100)  NOT NULL,
        NOMBRE_CAMPO     VARCHAR(200)  NOT NULL,
        ID_REPORTE       VARCHAR(100)  NULL,
        COLUMNA_REPORTE  INT           NULL,
        FECHA_CARGA      DATETIME      NOT NULL DEFAULT GETDATE()
      )
      CREATE INDEX IX_SLU_LAYOUT  ON SOFIPO_LAYOUT_USO (CLAVE_LAYOUT)
      CREATE INDEX IX_SLU_CAMPO   ON SOFIPO_LAYOUT_USO (NOMBRE_CAMPO)
      CREATE INDEX IX_SLU_REPORTE ON SOFIPO_LAYOUT_USO (ID_REPORTE)
      PRINT 'Tabla SOFIPO_LAYOUT_USO creada.'
    END
    ELSE PRINT 'Tabla SOFIPO_LAYOUT_USO ya existe.'
  `);

  // ── SOFIPO_REPORTES ───────────────────────────────────────
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'SOFIPO_REPORTES'
    )
    BEGIN
      CREATE TABLE SOFIPO_REPORTES (
        ID               INT IDENTITY(1,1) PRIMARY KEY,
        ID_REPORTE       VARCHAR(100)  NOT NULL,
        ORDEN            INT           NULL,
        NOMBRE_CAMPO     VARCHAR(300)  NULL,
        TIPO_DATO        VARCHAR(50)   NULL,
        LONGITUD         INT           NULL,
        DECIMALES        INT           NULL,
        FORMATO_CAPTURA  VARCHAR(100)  NULL,
        CATALOGO         VARCHAR(200)  NULL,
        FECHA_CARGA      DATETIME      NOT NULL DEFAULT GETDATE()
      )
      CREATE INDEX IX_SR_REPORTE ON SOFIPO_REPORTES (ID_REPORTE)
      PRINT 'Tabla SOFIPO_REPORTES creada.'
    END
    ELSE PRINT 'Tabla SOFIPO_REPORTES ya existe.'
  `);

  // ── AUDIT_LOG ─────────────────────────────────────────────
  // Bitácora de movimientos: quién hizo qué, cuándo y en qué sección
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'AUDIT_LOG'
    )
    BEGIN
      CREATE TABLE AUDIT_LOG (
        ID_AUDIT    INT IDENTITY(1,1) PRIMARY KEY,
        USUARIO     VARCHAR(100)  NOT NULL,
        SECCION     VARCHAR(50)   NOT NULL,   -- ej. 'estatus-reporte', 'estatus-validacion', 'upload-contratos'
        ACCION      VARCHAR(50)   NOT NULL,   -- ej. 'MARCAR', 'DESMARCAR', 'UPLOAD', 'LOGIN'
        DETALLE     VARCHAR(MAX)  NULL,       -- JSON con campos relevantes del cambio
        FECHA       DATETIME      NOT NULL DEFAULT GETDATE()
      )
      CREATE INDEX IX_AL_USUARIO ON AUDIT_LOG (USUARIO)
      CREATE INDEX IX_AL_SECCION ON AUDIT_LOG (SECCION)
      CREATE INDEX IX_AL_FECHA   ON AUDIT_LOG (FECHA DESC)
      PRINT 'Tabla AUDIT_LOG creada.'
    END
    ELSE PRINT 'Tabla AUDIT_LOG ya existe.'
  `);

  console.log('✅ Setup de tablas completado.');
}

module.exports = { setup };

// Ejecutar directo si: node db/setup.js
if (require.main === module) {
  setup()
    .then(() => process.exit(0))
    .catch(e => { console.error('❌ Error en setup:', e.message); process.exit(1); });
}
