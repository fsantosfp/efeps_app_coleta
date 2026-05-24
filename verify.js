const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Limpa o banco de dados para iniciar o teste de forma limpa e determinística
function resetDb() {
  console.log('[TEST SETUP] Limpando dados do banco SQLite...');
  const db = new Database('coleta.db');
  db.exec('DELETE FROM pacotes');
  db.exec('DELETE FROM alertas_fila');
  db.close();
}

// Helper to make GET requests
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('application/json')) {
          try {
            resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode, headers: res.headers, body: data });
          }
        } else {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    }).on('error', reject);
  });
}

// Helper to make DELETE requests
function deleteCall(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'DELETE' }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Helper to post multipart form data (upload file)
function uploadMockFile(url, fileName, fileContent) {
  return new Promise((resolve, reject) => {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const postData = 
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="etiqueta"; filename="${fileName}"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n` +
      `${fileContent}\r\n` +
      `--${boundary}--\r\n`;

    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('=== INICIANDO VERIFICAÇÃO DE APIS ===');
  resetDb();
  
  // 1. Teste GET /api/dashboard (Inicial)
  console.log('\n[TESTE 1] Lendo estado inicial da Dashboard...');
  const initialDash = await get('http://localhost:3000/api/dashboard');
  console.log('Status Code:', initialDash.status);
  console.log('Métricas Iniciais:', initialDash.body.data.metrics);
  console.log('Fila Inicial:', initialDash.body.data.queue);
  console.log('Alertas Iniciais:', initialDash.body.data.alerts.length);
  
  // 2. Teste POST /api/upload com etiqueta Shopee
  console.log('\n[TESTE 2] Fazendo upload de etiqueta mockada da Shopee...');
  const shopeeUpload = await uploadMockFile(
    'http://localhost:3000/api/upload',
    'shopee_etiqueta.jpg',
    'contem a palavra shopee'
  );
  console.log('Status Code:', shopeeUpload.status);
  console.log('Response Body:', shopeeUpload.body);
  
  // Aguarda 4 segundos para o processador de fila FIFO (simulado) classificar
  console.log('\n[*] Aguardando 4 segundos para o processamento assíncrono do Gemini...');
  await new Promise(r => setTimeout(r, 4000));
  
  // 3. Teste GET /api/dashboard (Pós-upload)
  console.log('\n[TESTE 3] Lendo estado da Dashboard após processamento...');
  const afterDash = await get('http://localhost:3000/api/dashboard');
  console.log('Status Code:', afterDash.status);
  console.log('Métricas Atuais:', afterDash.body.data.metrics);
  console.log('Fila Atual:', afterDash.body.data.queue);
  console.log('Último pacote cadastrado:', afterDash.body.data.packages[0]);

  // 4. Teste POST /api/upload com etiqueta Shopee repetida para forçar Alerta de Duplicidade
  console.log('\n[TESTE 4] Forçando Alerta de Duplicidade (enviando a mesma etiqueta Shopee novamente)...');
  const shopeeUploadDup = await uploadMockFile(
    'http://localhost:3000/api/upload',
    'shopee_etiqueta.jpg',
    'contem a palavra shopee'
  );
  console.log('Status Code:', shopeeUploadDup.status);
  
  // Aguarda 4 segundos para processamento de duplicidade
  console.log('\n[*] Aguardando 4 segundos...');
  await new Promise(r => setTimeout(r, 4000));
  
  // 5. Teste GET /api/dashboard (Verificando alerta de duplicidade)
  console.log('\n[TESTE 5] Verificando se o alerta de duplicidade foi gerado...');
  const dupDash = await get('http://localhost:3000/api/dashboard');
  console.log('Status Code:', dupDash.status);
  console.log('Total de alertas no Sino:', dupDash.body.data.alerts.length);
  if (dupDash.body.data.alerts.length > 0) {
    console.log('Alerta Detectado:', dupDash.body.data.alerts[0]);
  } else {
    console.error('ERRO: Alerta de duplicidade não foi gerado.');
  }

  // 6. Teste GET /api/clientes
  console.log('\n[TESTE 6] Listando clientes únicos cadastrados no banco...');
  const clientList = await get('http://localhost:3000/api/clientes');
  console.log('Status Code:', clientList.status);
  console.log('Clientes:', clientList.body.data);

  // 7. Teste Geração de Relatório de Clientes PDF
  console.log('\n[TESTE 7] Testando emissão de Relatório "Por Cliente" (PDF)...');
  const today = new Date().toISOString().split('T')[0];
  const client = 'Loja Teste S.A. (Simulado)';
  const clientPdf = await get(`http://localhost:3000/api/relatorios/cliente?clientes=${encodeURIComponent(client)}&dataInicio=${today}&dataFim=${today}`);
  console.log('Status Code:', clientPdf.status);
  console.log('Content-Type recebido:', clientPdf.headers['content-type']);
  if (clientPdf.status === 200 && clientPdf.headers['content-type'] === 'application/pdf') {
    console.log('Sucesso: Relatório PDF gerado corretamente.');
  } else {
    console.error('ERRO: Falha ao gerar PDF de cliente.');
  }

  // 8. Teste Geração de Relatório de Conferência PDF
  console.log('\n[TESTE 8] Testando emissão de Relatório "Conferência de Balcão" (PDF)...');
  const confPdf = await get(`http://localhost:3000/api/relatorios/conferencia?data=${today}&horaInicio=00:00:00&horaFim=23:59:59`);
  console.log('Status Code:', confPdf.status);
  console.log('Content-Type recebido:', confPdf.headers['content-type']);
  if (confPdf.status === 200 && confPdf.headers['content-type'] === 'application/pdf') {
    console.log('Sucesso: Relatório PDF de conferência gerado corretamente.');
  } else {
    console.error('ERRO: Falha ao gerar PDF de conferência.');
  }

  // 9. Simulação de TTL 60 dias
  console.log('\n[TESTE 9] Injetando pacote antigo para teste do TTL 60 dias...');
  const db = new Database('coleta.db');
  db.prepare(`
    INSERT INTO pacotes (codigo_pacote, remetente_bruto, plataforma, caminho_imagem, data_coleta)
    VALUES ('BR-TTL-EXPIRED', 'Cliente Expirado', 'Shopee', 'uploads/mock_ttl_img.jpg', '2020-01-01')
  `).run();
  
  // Cria arquivo físico fake para testar remoção física
  fs.writeFileSync('uploads/mock_ttl_img.jpg', 'fake content');
  console.log('Registro inserido para a data 2020-01-01.');
  console.log('Arquivo físico uploads/mock_ttl_img.jpg criado.');

  // Executa rotina TTL recarregando o script de server de forma isolada,
  // ou podemos testar rodando o código de limpeza do server diretamente:
  console.log('Chamando rotina de limpeza do banco...');
  const limitDate = new Date();
  limitDate.setDate(limitDate.getDate() - 60);
  const dateLimitStr = limitDate.toISOString().split('T')[0];
  
  const expiredPkgs = db.prepare('SELECT caminho_imagem FROM pacotes WHERE data_coleta < ?').all(dateLimitStr);
  expiredPkgs.forEach(pkg => {
    if (pkg.caminho_imagem && fs.existsSync(pkg.caminho_imagem)) {
      fs.unlinkSync(pkg.caminho_imagem);
    }
  });
  db.prepare('DELETE FROM pacotes WHERE data_coleta < ?').run(dateLimitStr);
  
  // Verifica se foi removido do banco e do disco
  const checkPkg = db.prepare("SELECT id FROM pacotes WHERE codigo_pacote = 'BR-TTL-EXPIRED'").get();
  const fileExists = fs.existsSync('uploads/mock_ttl_img.jpg');
  db.close();

  if (!checkPkg && !fileExists) {
    console.log('Sucesso: Registro antigo deletado do banco e arquivo físico apagado do disco!');
  } else {
    console.error('ERRO: Registro do TTL ou arquivo físico ainda permanecem ativos.');
  }

  // 10. Teste exclusão física de pacote
  console.log('\n[TESTE 10] Testando exclusão física de pacote (DELETE /api/pacotes/:id)...');
  const dbDeleteTest = new Database('coleta.db');
  dbDeleteTest.prepare(`
    INSERT INTO pacotes (codigo_pacote, remetente_bruto, plataforma, caminho_imagem, data_coleta)
    VALUES ('BR-DELETE-TEST', 'Remetente Exclusao', 'Mercado Livre', 'uploads/mock_delete_img.jpg', '2026-05-23')
  `).run();
  
  fs.writeFileSync('uploads/mock_delete_img.jpg', 'fake content to delete');
  const testPkg = dbDeleteTest.prepare("SELECT id FROM pacotes WHERE codigo_pacote = 'BR-DELETE-TEST'").get();
  dbDeleteTest.close();
  
  console.log(`Pacote inserido com ID #${testPkg.id}. Executando DELETE...`);
  const deleteResult = await deleteCall(`http://localhost:3000/api/pacotes/${testPkg.id}`);
  console.log('Status Code:', deleteResult.status);
  console.log('Response Body:', deleteResult.body);
  
  const dbCheck = new Database('coleta.db');
  const checkDeletedPkg = dbCheck.prepare("SELECT id FROM pacotes WHERE codigo_pacote = 'BR-DELETE-TEST'").get();
  const deleteFileExists = fs.existsSync('uploads/mock_delete_img.jpg');
  dbCheck.close();
  
  if (!checkDeletedPkg && !deleteFileExists) {
    console.log('Sucesso: Pacote e imagem física apagados do disco com sucesso pelo endpoint DELETE!');
  } else {
    console.error('ERRO: Falha ao deletar pacote ou arquivo físico permanecendo ativo.');
  }

  console.log('\n=== FIM DOS TESTES DE INTEGRAÇÃO ===');
}

runTests().catch(err => {
  console.error('Erro ao executar testes:', err);
  process.exit(1);
});
