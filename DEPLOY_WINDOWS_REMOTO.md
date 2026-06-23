# Guía de Deploy Remoto — Bajaware en Windows Server

## Prerrequisitos (desde casa)
- FortiClient VPN conectado
- IP del servidor: `192.168.94.14`
- Usuario: `jmorfin`
- Contraseña Windows: la tuya de acceso al servidor

---

## FASE 1 — Conectar al servidor remotamente

**Desde tu Mac:**
```bash
# Habilitar escritorio remoto en el servidor (si aún no está activo)
# Se hace una sola vez desde la oficina o pidiéndole a alguien que lo active
```

Una vez habilitado el RDP (Remote Desktop):
1. Abre **Finder → Aplicaciones → Microsoft Remote Desktop** (o descárgalo gratis del App Store)
2. Agrega una nueva PC con IP: `192.168.94.14`
3. Usuario: `jmorfin` → contraseña: la tuya de Windows
4. Conectar → ya estás dentro del servidor desde tu casa

> Alternativa si no tienes Microsoft Remote Desktop: usa `Remmina` o simplemente `ssh` si el servidor tiene OpenSSH habilitado.

---

## FASE 2 — Instalar Node.js en el servidor

Dentro del servidor (vía RDP):

1. Abre el navegador y ve a: https://nodejs.org
2. Descarga la versión **LTS** (recomendada, actualmente v20.x)
3. Ejecuta el instalador `.msi` → siguiente, siguiente, instalar
4. Verifica en CMD o PowerShell:
```powershell
node --version   # debe mostrar v20.x.x
npm --version    # debe mostrar 10.x.x
```

---

## FASE 3 — Instalar Git

1. Ve a: https://git-scm.com/download/win
2. Descarga e instala con opciones por defecto
3. Verifica:
```powershell
git --version
```

---

## FASE 4 — Clonar el proyecto

En PowerShell o CMD dentro del servidor:

```powershell
# Navega a donde quieres poner el proyecto
cd C:\
mkdir Apps
cd Apps

# Clona el repositorio
git clone https://github.com/M0f3m4/BajawareDB.git bajaware
cd bajaware
```

Si el repo es privado, GitHub pedirá usuario y token (usa un Personal Access Token, no la contraseña).

---

## FASE 5 — Crear el archivo .env

El `.env` **no está en el repo** (está en .gitignore por seguridad). Tienes que crearlo manualmente:

```powershell
notepad .env
```

Pega esto y rellena los valores reales:
```env
PORT=3000
SESSION_SECRET=bajaware-secret-prod

# SQL Server
DB_SERVER=192.168.94.43
DB_NAME=BASECONOCIMIENTO_COPIA
DB_USER=tu_usuario_db
DB_PASSWORD=tu_password_db

# Jira
JIRA_HOST=https://bajaware.atlassian.net
JIRA_EMAIL=tu_email@bajaware.com
JIRA_TOKEN=tu_api_token_de_jira
```

Guarda y cierra el Notepad.

---

## FASE 6 — Instalar dependencias

```powershell
npm install
```

Espera a que termine (descarga node_modules).

---

## FASE 7 — Verificar que conecta con la DB

```powershell
node -e "require('dotenv').config(); const { query } = require('./db/connection'); query('SELECT 1 AS ok').then(r => { console.log('✅ DB conectada:', r); process.exit(0); }).catch(e => { console.error('❌ Error DB:', e.message); process.exit(1); })"
```

Si sale `✅ DB conectada` → todo bien, continúa.
Si sale error → revisa usuario/contraseña en el .env o que el puerto 1433 no esté bloqueado por el firewall del servidor.

---

## FASE 8 — Instalar pm2 y levantar la app

```powershell
npm install -g pm2
npm install -g pm2-windows-startup

# Levantar la app
pm2 start server.js --name bajaware

# Ver que está corriendo
pm2 status

# Ver logs en tiempo real
pm2 logs bajaware
```

---

## FASE 9 — Que la app arranque automáticamente al reiniciar Windows

```powershell
pm2-windows-startup install
pm2 save
```

Con esto, si el servidor se reinicia, la app vuelve sola sin que hagas nada.

---

## FASE 10 — Abrir el puerto en el firewall de Windows

Para que otros en la red puedan acceder:

1. Busca **"Windows Defender Firewall"** en el menú inicio
2. **Reglas de entrada → Nueva regla**
3. Tipo: **Puerto** → TCP → Puerto específico: **3000**
4. Acción: **Permitir la conexión**
5. Aplica a: **Dominio + Privado** (no necesitas público)
6. Nombre: `Bajaware`

---

## Acceso a la app

Una vez desplegada, la app está disponible en:

```
http://[IP-DEL-SERVIDOR]:3000
```

- **Desde la oficina:** directo con esa URL
- **Desde casa:** conectas FortiClient VPN → misma URL

---

## Comandos útiles de pm2

```powershell
pm2 status              # estado de la app
pm2 logs bajaware       # logs en vivo
pm2 restart bajaware    # reiniciar (tras cambios)
pm2 stop bajaware       # detener
```

## Actualizar el código después

Cuando haya cambios en el repo:
```powershell
cd C:\Apps\bajaware
git pull
npm install             # solo si cambiaron dependencias
pm2 restart bajaware
```
