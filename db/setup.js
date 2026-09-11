/**
 * db/setup.js
 * Crea tablas necesarias si no existen.
 * Ejecutar una vez con: node db/setup.js
 * O se llama automáticamente desde server.js al arrancar.
 */

require('dotenv').config();
const { query } = require('./connection');

/**
 * setup()
 * Crea y actualiza todas las tablas necesarias en SQL Server (idempotente).
 *
 * TABLAS CREADAS (si no existen):
 *  - LAYOUT_VERSIONES: Versionado semántico (MAJOR.MINOR.PATCH) vinculado a tickets Jira QD/CDL
 *  - QA_ALERTAS: Tickets QD/CDL en "Instalados en QA" pendientes de procesamiento
 *  - SOFIPO_LAYOUT_DESC: Metadata de campos SOFIPO (tipos, validaciones, catálogos)
 *  - SOFIPO_LAYOUT_USO: Vinculación campos SOFIPO ↔ reportes
 *  - SOFIPO_REPORTES: Estructura de reportes SOFIPO
 *  - AUDIT_LOG: Bitácora de todas las acciones (quién, qué, cuándo, dónde)
 *  - INVENTARIO_VERSIONES: Versionador central para reportes/validaciones/layouts
 *  - PROYECTOS: Proyectos ligados a contratos (RAG, líderes, avance, semáforos)
 *  - PROYECTOS_REPORTES: Liga N:M proyecto ↔ reportes del contrato padre
 *  - PROY_RAG_ALERTAS: Alertas de cambio de semáforo en RAG producto
 *  - PROYECTOS_RESPALDO: Snapshots semanales del tablero de proyectos
 *
 * ALTERACIONES DE COLUMNAS (agregadas después del release inicial):
 *  - PROYECTOS: RAG_REPORTES_MANUAL, RAG_VALIDACIONES_MANUAL, TIPO_INSTITUCION, FECHA_NECESIDAD, RAG_PRODUCTO_ULTIMO
 *  - CLIENTE: TIPO_INSTITUCION, FECHA_MODIFICA
 *  - CONTRATOS_REPORTES: FECHA_NECESIDAD, FECHA_ESTIMADA_QA, FECHA_INSTALADO_QA, FECHA_ESTIMADA_CERT, FECHA_CERTIFICADO, FECHA_ESTIMADA_PROD, FECHA_INSTALADO_PROD
 *  - CONTRATOS_VALIDACION_ESTATUS: FECHA_NECESIDAD, FECHA_ESTIMADA, FECHA_REAL
 *
 * INVOCACIÓN:
 *  - Automática: server.js al arrancar (pm2 restart crea tablas nuevas)
 *  - Manual: node db/setup.js (verificación/setup independiente)
 *
 * IDEMPOTENCIA: IF NOT EXISTS en CREATE TABLE y COL_LENGTH en ALTER TABLE previenen
 * errores si se llama múltiples veces (safe en prod con tablas previas).
 */
async function setup() {
  console.log('🔧 Verificando / creando tablas...');

  // ── LAYOUT_VERSIONES ──────────────────────────────────────
  // Versión semántica (MAJOR.MINOR.PATCH) vinculada a tickets Jira QD/CDL.
  // Registra cada cambio de layout (nuevo campo, cambio de tipo, cambio de descripción).
  // Índices: CLAVE_LAYOUT (búsqueda por layout), JIRA_TICKET (por ticket), FECHA_CARGA (historial).
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
  // Tickets QD/CDL detectados automáticamente en "Instalados en QA" pendientes de procesamiento.
  // Workflow: PENDIENTE (espera Excel) → PROCESADO (Excel subido, versión generada) o IGNORADO (descartar).
  // El usuario confirma manualmente el layout detectado (CLAVE_LAYOUT_FINAL).
  // Índices: JIRA_TICKET (UNIQUE, un ticket = una alerta), ESTADO (para filtrar pendientes).
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
  // Metadata de campos SOFIPO: clave de layout, nombre campo, tipo dato, formato, obligatorio,
  // validaciones permitidas y catálogos. Se carga via importar-sofipo.js desde Excel oficial.
  // Índices: CLAVE_LAYOUT (búsqueda de campos en un layout), NOMBRE_CAMPO (búsqueda inversa).
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
  // Vinculación: qué campo SOFIPO se usa en qué reporte y en qué columna (posición).
  // Permite detectar si un campo cambió de posición o se elimina de un reporte.
  // Índices: CLAVE_LAYOUT (por layout), NOMBRE_CAMPO (por campo), ID_REPORTE (por reporte).
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
  // Estructura de reportes SOFIPO: columnas, tipos, longitudes, decimales, catálogos permitidos.
  // Se carga via importar-sofipo.js desde Excel oficial. Define la "firma" de cada reporte.
  // Índice: ID_REPORTE (búsqueda de estructura por reporte).
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
  // Bitácora exhaustiva: quién (USUARIO), hizo qué (ACCION), dónde (SECCION), cuándo (FECHA).
  // DETALLE: JSON con datos relevantes del cambio (ej: ID_REPORTE, estado_anterior, estado_nuevo).
  // SECCION ejemplos: 'estatus-reporte', 'estatus-validacion', 'upload-contratos', 'login', 'marcar-rag'.
  // ACCION ejemplos: 'MARCAR', 'DESMARCAR', 'UPLOAD', 'LOGIN', 'GENERAR_ALERTA'.
  // Índices: USUARIO (quién hizo qué), SECCION (filtrar por módulo), FECHA DESC (historial reciente).
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

  // ── INVENTARIO_VERSIONES ──────────────────────────────────
  // Versionador central: registra todas las cargas de reportes, validaciones y layouts con versión semántica.
  // TIPO_OBJETO: 'REPORTE', 'VALIDACION' o 'LAYOUT'.
  // ESTATUS: 'IDENTIFICADO', 'EN_QA', 'CERTIFICADO', etc.
  // Migración inicial (al crear tabla): inserta 1.0.0 para todos los datos previos desde INVENTARIO_REPORTES, REPORTE_VALIDACION, SOFIPO_LAYOUT_DESC.
  // Índices: (TIPO_OBJETO, CLAVE_OBJ) para búsqueda rápida, FECHA_CARGA para historial.
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'INVENTARIO_VERSIONES'
    )
    BEGIN
      CREATE TABLE INVENTARIO_VERSIONES (
        ID_VERSION    INT IDENTITY(1,1) PRIMARY KEY,
        TIPO_OBJETO   VARCHAR(20)   NOT NULL,   -- 'REPORTE', 'VALIDACION', 'LAYOUT'
        CLAVE_OBJ     VARCHAR(100)  NOT NULL,
        VERSION       VARCHAR(20)   NOT NULL DEFAULT '1.0.0',
        REGULACION    VARCHAR(100)  NULL,
        TIPO_VERSION  VARCHAR(30)   NULL,       -- 'BASE', 'CAMBIO REG', 'FIX'
        DESCRIPCION   VARCHAR(500)  NULL,
        ESTATUS       VARCHAR(30)   NOT NULL DEFAULT 'IDENTIFICADO',
        USUARIO       VARCHAR(100)  NOT NULL DEFAULT 'sistema',
        FECHA_CARGA   DATETIME      NOT NULL DEFAULT GETDATE()
      )
      CREATE INDEX IX_IV_TIPO_CLAVE ON INVENTARIO_VERSIONES (TIPO_OBJETO, CLAVE_OBJ)
      CREATE INDEX IX_IV_FECHA      ON INVENTARIO_VERSIONES (FECHA_CARGA DESC)
      PRINT 'Tabla INVENTARIO_VERSIONES creada.'

      -- Migración automática: versión 1.0.0 para todos los datos existentes
      INSERT INTO INVENTARIO_VERSIONES (TIPO_OBJETO, CLAVE_OBJ, VERSION, REGULACION, TIPO_VERSION, DESCRIPCION, ESTATUS, USUARIO)
        SELECT 'REPORTE', CLAVE_REP, '1.0.0', 'INICIAL', 'BASE', 'Versión inicial', 'IDENTIFICADO', 'sistema'
        FROM INVENTARIO_REPORTES
        WHERE CLAVE_REP IS NOT NULL

      INSERT INTO INVENTARIO_VERSIONES (TIPO_OBJETO, CLAVE_OBJ, VERSION, REGULACION, TIPO_VERSION, DESCRIPCION, ESTATUS, USUARIO)
        SELECT DISTINCT 'VALIDACION', CLAVE_VALIDACION, '1.0.0', 'INICIAL', 'BASE', 'Versión inicial', 'IDENTIFICADO', 'sistema'
        FROM REPORTE_VALIDACION
        WHERE CLAVE_VALIDACION IS NOT NULL

      INSERT INTO INVENTARIO_VERSIONES (TIPO_OBJETO, CLAVE_OBJ, VERSION, REGULACION, TIPO_VERSION, DESCRIPCION, ESTATUS, USUARIO)
        SELECT DISTINCT 'LAYOUT', CLAVE_LAYOUT, '1.0.0', 'INICIAL', 'BASE', 'Versión inicial', 'IDENTIFICADO', 'sistema'
        FROM SOFIPO_LAYOUT_DESC
        WHERE CLAVE_LAYOUT IS NOT NULL

      PRINT 'Migración 1.0.0 completada.'
    END
    ELSE PRINT 'Tabla INVENTARIO_VERSIONES ya existe.'
  `);

  // ── PROYECTOS ─────────────────────────────────────────────
  // Proyectos ligados a contratos. Réplica del Excel del área de PMO:
  // CLIENTE → CONTRATOS → PROYECTOS (relación jerárquica).
  // Campos: nombre, tipo (PROYECTO/CAMBIO_REGULATORIO/SOPORTE/CUSTOMER_S), tipo institución,
  //        estatus pago, líderes (funcional/técnico), RAG manual/automático, avance estimado,
  //        fechas (necesidad, estimada conclusión), flags de semáforo manual (NULL = automático).
  // Índices: CLAVE_CONTRATO (obtener proyectos de un contrato), TIPO_ACTIVIDAD (filtrar por tipo).
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'PROYECTOS'
    )
    BEGIN
      CREATE TABLE PROYECTOS (
        ID_PROYECTO             INT IDENTITY(1,1) PRIMARY KEY,
        CLAVE_CONTRATO          VARCHAR(100)  NOT NULL,   -- contrato padre
        NOMBRE_PROYECTO         VARCHAR(300)  NOT NULL,
        TIPO_ACTIVIDAD          VARCHAR(30)   NULL,       -- PROYECTO / CAMBIO_REGULATORIO / SOPORTE / CUSTOMER_S
        TIPO_INSTITUCION        VARCHAR(50)   NULL,       -- por proyecto; NULL = hereda el del cliente
        ESTATUS_PAGO            VARCHAR(50)   NULL,
        FUNCIONAL_NOMBRE        VARCHAR(150)  NULL,
        TECNICO_NOMBRE          VARCHAR(150)  NULL,
        RAG_PROYECTO            VARCHAR(10)   NULL,       -- Green / Amber / Red (manual)
        RAG_COMENTARIO          VARCHAR(500)  NULL,
        RAG_FECHA               DATETIME      NULL,
        RAG_USUARIO             VARCHAR(100)  NULL,
        RAG_REPORTES_MANUAL     VARCHAR(10)   NULL,       -- override manual del semáforo de reportes (NULL = automático)
        RAG_VALIDACIONES_MANUAL VARCHAR(10)   NULL,       -- override manual del semáforo de validaciones (NULL = automático)
        AVANCE_ESTIMADO         DECIMAL(5,2)  NULL,       -- 0-100
        FECHA_NECESIDAD         DATE          NULL,       -- fecha límite/compromiso del proyecto
        FECHA_ESTIMADA_CONCLUIR DATE          NULL,
        ACTIVO                  BIT           NOT NULL DEFAULT 1,
        USUARIO_ALTA            VARCHAR(100)  NULL,
        FECHA_ALTA              DATETIME      NOT NULL DEFAULT GETDATE(),
        FECHA_MODIFICA          DATETIME      NULL
      )
      CREATE INDEX IX_PROY_CONTRATO ON PROYECTOS (CLAVE_CONTRATO)
      CREATE INDEX IX_PROY_TIPO     ON PROYECTOS (TIPO_ACTIVIDAD)
      PRINT 'Tabla PROYECTOS creada.'
    END
    ELSE PRINT 'Tabla PROYECTOS ya existe.'
  `);

  // ── PROYECTOS_REPORTES ────────────────────────────────────
  // Liga N:M entre proyecto y reportes del contrato padre (subconjunto selectivo).
  // Permite marcar "este proyecto trabaja SOLO con estos reportes" (subset de CONTRATOS_REPORTES).
  // UNIQUE (ID_PROYECTO, CLAVE_REP) previene duplicados.
  // Índice: ID_PROYECTO (obtener reportes de un proyecto).
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'PROYECTOS_REPORTES'
    )
    BEGIN
      CREATE TABLE PROYECTOS_REPORTES (
        ID_PROY_REP  INT IDENTITY(1,1) PRIMARY KEY,
        ID_PROYECTO  INT           NOT NULL,   -- FK lógica a PROYECTOS
        CLAVE_REP    VARCHAR(100)  NOT NULL,   -- clave base (como en CONTRATOS_REPORTES)
        USUARIO_ALTA VARCHAR(100)  NULL,
        FECHA_ALTA   DATETIME      NOT NULL DEFAULT GETDATE(),
        CONSTRAINT UQ_PROYREP UNIQUE (ID_PROYECTO, CLAVE_REP)
      )
      CREATE INDEX IX_PROYREP_PROY ON PROYECTOS_REPORTES (ID_PROYECTO)
      PRINT 'Tabla PROYECTOS_REPORTES creada.'
    END
    ELSE PRINT 'Tabla PROYECTOS_REPORTES ya existe.'
  `);

  // ── Alteraciones de columnas en PROYECTOS ──────────────────────────────
  // Columnas agregadas después del release inicial (idempotentes: si ya existen, no hacen nada).
  // Motivo: desarrollo iterativo en dev sin actualizar setup.js hasta después de desplegar.
  // En prod, pm2 restart ejecuta este bloque y agrega columnas faltantes automáticamente.
  await query(`
    IF COL_LENGTH('PROYECTOS', 'RAG_REPORTES_MANUAL') IS NULL
      ALTER TABLE PROYECTOS ADD RAG_REPORTES_MANUAL VARCHAR(10) NULL
  `);
  await query(`
    IF COL_LENGTH('PROYECTOS', 'RAG_VALIDACIONES_MANUAL') IS NULL
      ALTER TABLE PROYECTOS ADD RAG_VALIDACIONES_MANUAL VARCHAR(10) NULL
  `);
  await query(`
    IF COL_LENGTH('PROYECTOS', 'TIPO_INSTITUCION') IS NULL
      ALTER TABLE PROYECTOS ADD TIPO_INSTITUCION VARCHAR(50) NULL
  `);
  await query(`
    IF COL_LENGTH('PROYECTOS', 'FECHA_NECESIDAD') IS NULL
      ALTER TABLE PROYECTOS ADD FECHA_NECESIDAD DATE NULL
  `);
  // ── Alteraciones en CLIENTE ────────────────────────────────────────────
  // TIPO_INSTITUCION: fallback del tipo de institución (si proyecto no tiene, hereda del cliente).
  // Tablero usa: ISNULL(p.TIPO_INSTITUCION, cl.TIPO_INSTITUCION).
  // Bug histórico: agregado a mano en dev (ALTER manual), nunca en setup.js → prod sin la columna.
  // FECHA_MODIFICA: tracking de cambios (auditoría ligera a nivel cliente).
  await query(`
    IF COL_LENGTH('CLIENTE', 'TIPO_INSTITUCION') IS NULL
      ALTER TABLE CLIENTE ADD TIPO_INSTITUCION VARCHAR(50) NULL
  `);
  await query(`
    IF COL_LENGTH('CLIENTE', 'FECHA_MODIFICA') IS NULL
      ALTER TABLE CLIENTE ADD FECHA_MODIFICA DATETIME NULL
  `);

  // ── Alteraciones en CONTRATOS_REPORTES y CONTRATOS_VALIDACION_ESTATUS ──
  // Fechas de semáforos para RAG del tablero de proyectos (agregadas 2026-09-04).
  // FECHA_NECESIDAD: deadline del reporte/validación.
  // FECHA_ESTIMADA_*: pronóstico (QA, CERT, PROD).
  // FECHA_INSTALADO_*: cuando realmente se instaló.
  // FECHA_CERTIFICADO/FECHA_REAL: fechas finales de cumplimiento.
  // Bug histórico: agregado a mano en dev (ALTER manual), nunca en setup.js → prod explotaba con "Invalid column".
  // Idempotentes: COL_LENGTH(...) IS NULL previene errores si ya existen.
  await query(`
    IF COL_LENGTH('CONTRATOS_REPORTES', 'FECHA_NECESIDAD') IS NULL
      ALTER TABLE CONTRATOS_REPORTES ADD FECHA_NECESIDAD DATE NULL
  `);
  await query(`
    IF COL_LENGTH('CONTRATOS_REPORTES', 'FECHA_ESTIMADA_QA') IS NULL
      ALTER TABLE CONTRATOS_REPORTES ADD FECHA_ESTIMADA_QA DATE NULL
  `);
  await query(`
    IF COL_LENGTH('CONTRATOS_REPORTES', 'FECHA_INSTALADO_QA') IS NULL
      ALTER TABLE CONTRATOS_REPORTES ADD FECHA_INSTALADO_QA DATE NULL
  `);
  await query(`
    IF COL_LENGTH('CONTRATOS_REPORTES', 'FECHA_ESTIMADA_CERT') IS NULL
      ALTER TABLE CONTRATOS_REPORTES ADD FECHA_ESTIMADA_CERT DATE NULL
  `);
  await query(`
    IF COL_LENGTH('CONTRATOS_REPORTES', 'FECHA_CERTIFICADO') IS NULL
      ALTER TABLE CONTRATOS_REPORTES ADD FECHA_CERTIFICADO DATE NULL
  `);
  await query(`
    IF COL_LENGTH('CONTRATOS_REPORTES', 'FECHA_ESTIMADA_PROD') IS NULL
      ALTER TABLE CONTRATOS_REPORTES ADD FECHA_ESTIMADA_PROD DATE NULL
  `);
  await query(`
    IF COL_LENGTH('CONTRATOS_REPORTES', 'FECHA_INSTALADO_PROD') IS NULL
      ALTER TABLE CONTRATOS_REPORTES ADD FECHA_INSTALADO_PROD DATE NULL
  `);
  await query(`
    IF COL_LENGTH('CONTRATOS_VALIDACION_ESTATUS', 'FECHA_NECESIDAD') IS NULL
      ALTER TABLE CONTRATOS_VALIDACION_ESTATUS ADD FECHA_NECESIDAD DATE NULL
  `);
  await query(`
    IF COL_LENGTH('CONTRATOS_VALIDACION_ESTATUS', 'FECHA_ESTIMADA') IS NULL
      ALTER TABLE CONTRATOS_VALIDACION_ESTATUS ADD FECHA_ESTIMADA DATE NULL
  `);
  await query(`
    IF COL_LENGTH('CONTRATOS_VALIDACION_ESTATUS', 'FECHA_REAL') IS NULL
      ALTER TABLE CONTRATOS_VALIDACION_ESTATUS ADD FECHA_REAL DATE NULL
  `);

  // ── Alteración en PROYECTOS.RAG_PRODUCTO_ULTIMO ────────────────────────
  // Guarda el último color de RAG producto observado (Green/Amber/Red).
  // RAG producto se calcula al vuelo; esta columna detecta cambios de color para generar PROY_RAG_ALERTAS.
  // Permite alertar: "RAG cambió de Green a Red, revisa los reportes".
  await query(`
    IF COL_LENGTH('PROYECTOS', 'RAG_PRODUCTO_ULTIMO') IS NULL
      ALTER TABLE PROYECTOS ADD RAG_PRODUCTO_ULTIMO VARCHAR(10) NULL
  `);

  // ── PROY_RAG_ALERTAS ──────────────────────────────────────
  // Alertas de cambio de semáforo en RAG producto.
  // Workflow: cada vez que RAG calculado ≠ RAG_PRODUCTO_ULTIMO, se crea alerta → usuario la lee (LEIDA, FECHA_LEIDA, USUARIO_LEIDA).
  // Permite el tablero mostrar "N alertas sin leer" y auditar qué cambios de RAG se notificaron.
  // Índices: ID_PROYECTO (alertas de un proyecto), FECHA_ALERTA (historial ordenado).
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'PROY_RAG_ALERTAS'
    )
    BEGIN
      CREATE TABLE PROY_RAG_ALERTAS (
        ID_ALERTA      INT IDENTITY(1,1) PRIMARY KEY,
        ID_PROYECTO    INT           NOT NULL,
        RAG_ANTERIOR   VARCHAR(10)   NULL,       -- color previo (Green/Amber/Red)
        RAG_NUEVO      VARCHAR(10)   NULL,       -- color nuevo
        PCT_NUEVO      DECIMAL(5,1)  NULL,       -- % certificados al momento del cambio
        FECHA_ALERTA   DATETIME      NOT NULL DEFAULT GETDATE(),
        LEIDA          BIT           NOT NULL DEFAULT 0,
        FECHA_LEIDA    DATETIME      NULL,
        USUARIO_LEIDA  VARCHAR(100)  NULL
      )
      CREATE INDEX IX_PROYALER_PROY  ON PROY_RAG_ALERTAS (ID_PROYECTO)
      CREATE INDEX IX_PROYALER_FECHA ON PROY_RAG_ALERTAS (FECHA_ALERTA)
      PRINT 'Tabla PROY_RAG_ALERTAS creada.'
    END
    ELSE PRINT 'Tabla PROY_RAG_ALERTAS ya existe.'
  `);

  // ── PROYECTOS_RESPALDO ────────────────────────────────────
  // Snapshots semanales del tablero de proyectos (histórico para comparativas).
  // Motor de respaldos automáticos: cada viernes 20:00 Pacífico toma foto completa (motivo='SEMANAL').
  // Estructura idéntica a PROYECTOS + metadatos de respaldo (FECHA_RESPALDO, MOTIVO, USUARIO_RESPALDO).
  // Permite: "¿qué cambió semana pasada?", "¿cuándo cambió RAG de Green a Red?", análisis de tendencias.
  // Retención: indefinida (aprox. 40 filas/semana × 52 semanas/año = 2080 filas/año → bajo impacto).
  // Índice: FECHA_RESPALDO (búsqueda por período de tiempo).
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'PROYECTOS_RESPALDO'
    )
    BEGIN
      CREATE TABLE PROYECTOS_RESPALDO (
        ID_RESPALDO             INT IDENTITY(1,1) PRIMARY KEY,
        ID_PROYECTO             INT           NOT NULL,     -- ID original (sin identity)
        CLAVE_CONTRATO          VARCHAR(100)  NOT NULL,
        NOMBRE_PROYECTO         VARCHAR(300)  NOT NULL,
        TIPO_ACTIVIDAD          VARCHAR(30)   NULL,
        TIPO_INSTITUCION        VARCHAR(50)   NULL,
        ESTATUS_PAGO            VARCHAR(50)   NULL,
        FUNCIONAL_NOMBRE        VARCHAR(150)  NULL,
        TECNICO_NOMBRE          VARCHAR(150)  NULL,
        RAG_PROYECTO            VARCHAR(10)   NULL,
        RAG_COMENTARIO          VARCHAR(500)  NULL,
        RAG_FECHA               DATETIME      NULL,
        RAG_USUARIO             VARCHAR(100)  NULL,
        RAG_REPORTES_MANUAL     VARCHAR(10)   NULL,
        RAG_VALIDACIONES_MANUAL VARCHAR(10)   NULL,
        AVANCE_ESTIMADO         DECIMAL(5,2)  NULL,
        FECHA_NECESIDAD         DATE          NULL,
        FECHA_ESTIMADA_CONCLUIR DATE          NULL,
        ACTIVO                  BIT           NOT NULL DEFAULT 1,
        USUARIO_ALTA            VARCHAR(100)  NULL,
        FECHA_ALTA              DATETIME      NULL,
        FECHA_MODIFICA          DATETIME      NULL,
        -- Metadatos estándar del motor de respaldos
        FECHA_RESPALDO          DATETIME      NOT NULL DEFAULT GETDATE(),
        MOTIVO                  VARCHAR(200)  NULL,
        USUARIO_RESPALDO        VARCHAR(100)  NULL
      )
      CREATE INDEX IX_PROYRESP_FECHA ON PROYECTOS_RESPALDO (FECHA_RESPALDO)
      PRINT 'Tabla PROYECTOS_RESPALDO creada.'
    END
    ELSE PRINT 'Tabla PROYECTOS_RESPALDO ya existe.'
  `);

  console.log('✅ Setup de tablas completado.');
}

// ── Exportar ───────────────────────────────────────────────────────────
// setup: función para inicialización (llamada desde server.js)
module.exports = { setup };

// ── Permitir ejecución como script independiente ─────────────────────
// Uso: node db/setup.js
// Útil para verificación/recreación manual sin arrancar toda la app.
if (require.main === module) {
  setup()
    .then(() => process.exit(0))
    .catch(e => { console.error('❌ Error en setup:', e.message); process.exit(1); });
}
