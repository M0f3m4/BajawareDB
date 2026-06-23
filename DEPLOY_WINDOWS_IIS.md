# Deploy Bajaware — IIS como proxy + Node.js en Windows

## Arquitectura
```
Usuario → http://192.168.94.14  →  IIS (puerto 80)  →  Node.js (puerto 3000)
```
IIS recibe el tráfico y lo reenvía a Node. Node nunca se expone directo.

---

## FASE 1 — Alguien en la oficina instala Node.js

> Esta fase requiere acceso físico o RDP al servidor. Solo se hace una vez.

1. Ir a https://nodejs.org y descargar la versión **LTS** (v20.x)
2. Ejecutar el instalador `.msi` → siguiente, siguiente, instalar
3. Verificar en PowerShell:
```powershell
node --version
npm --version
```

---

## FASE 2 — Instalar módulos de IIS necesarios

IIS necesita dos módulos para funcionar como proxy. Instalar desde PowerShell como administrador:

```powershell
# Habilitar módulo de proxy en IIS
Install-WindowsFeature Web-Url-Auth
```

Luego descargar e instalar manualmente (alguien en la oficina):
- **URL Rewrite**: https://www.iis.net/downloads/microsoft/url-rewrite
- **Application Request Routing (ARR)**: https://www.iis.net/downloads/microsoft/application-request-routing

Ambos son instaladores `.msi` simples. Después de instalar, reiniciar IIS:
```powershell
iisreset
```

---

## FASE 3 — Clonar el proyecto

En PowerShell dentro del servidor:

```powershell
cd C:\inetpub
mkdir bajaware
cd bajaware
git clone https://github.com/M0f3m4/BajawareDB.git .
```

Si Git no está instalado: https://git-scm.com/download/win

---

## FASE 4 — Crear el archivo .env

```powershell
notepad C:\inetpub\bajaware\.env
```

Contenido (rellenar con valores reales):
```env
PORT=3000
SESSION_SECRET=bajaware-secret-prod

DB_SERVER=192.168.94.43
DB_NAME=BASECONOCIMIENTO_COPIA
DB_USER=tu_usuario_db
DB_PASSWORD=tu_password_db

JIRA_HOST=https://bajaware.atlassian.net
JIRA_EMAIL=tu_email@bajaware.com
JIRA_TOKEN=tu_api_token_de_jira
```

---

## FASE 5 — Instalar dependencias y pm2

```powershell
cd C:\inetpub\bajaware
npm install

npm install -g pm2
npm install -g pm2-windows-startup

# Levantar Node en puerto 3000
pm2 start server.js --name bajaware
pm2 save
pm2-windows-startup install
```

Verificar que Node responde:
```powershell
# Debe devolver algo de HTML/JSON
Invoke-WebRequest http://localhost:3000 -UseBasicParsing
```

---

## FASE 6 — Configurar IIS como proxy inverso

### 6.1 Habilitar proxy en ARR

1. Abre **IIS Manager** (busca "IIS" en el menú inicio)
2. Clic en el servidor raíz (no en un sitio específico)
3. Doble clic en **Application Request Routing Cache**
4. En el panel derecho: **Server Proxy Settings**
5. Marca **Enable proxy** → Apply

### 6.2 Crear regla de reenvío en el sitio Default

1. En IIS Manager → **Sites → Default Web Site**
2. Doble clic en **URL Rewrite**
3. **Add Rule(s)** → **Reverse Proxy**
4. En "Inbound Rules - Server name": `localhost:3000`
5. Deja marcado "Enable SSL Offloading"
6. OK

### 6.3 Verificar el web.config generado

IIS crea automáticamente un `web.config` en `C:\inetpub\wwwroot\`. Debe verse así:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="Bajaware Proxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://localhost:3000/{R:1}" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
```

Si no se generó automáticamente, créalo manualmente en `C:\inetpub\wwwroot\web.config`.

---

## FASE 7 — Probar

Desde cualquier equipo en la red (o desde casa con VPN):
```
http://192.168.94.14
```

Debe aparecer el login de Bajaware.

---

## Comandos útiles

```powershell
pm2 status              # estado de Node
pm2 logs bajaware       # logs en vivo
pm2 restart bajaware    # reiniciar tras cambios
iisreset                # reiniciar IIS si algo falla
```

## Actualizar el código

```powershell
cd C:\inetpub\bajaware
git pull
npm install        # solo si cambiaron dependencias
pm2 restart bajaware
```

---

## Resumen de quién hace qué

| Tarea | Quién |
|-------|-------|
| Instalar Node.js en el servidor | Alguien en la oficina (una vez) |
| Instalar URL Rewrite + ARR | Alguien en la oficina (una vez) |
| Clonar repo, .env, npm install, pm2 | Tú (vía RDP o en persona) |
| Configurar IIS proxy | Tú (vía RDP o en persona) |
| Actualizaciones futuras | Tú (vía RDP desde casa con VPN) |
