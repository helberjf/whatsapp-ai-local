# Abrir a central pelo Milhas

O arquivo `whatsapp-local.cjs` é o adaptador que inicia a central em segundo plano e retorna `http://127.0.0.1:8766/`. Copie-o para a raiz do projeto Milhas. A instalação existente em `Documents\ChatGPT\milhas` já foi atualizada.

Por padrão, o adaptador usa `%USERPROFILE%\projects\whatsapp-central`. Para instalar em outro caminho, configure `WHATSAPP_CENTRAL_DIR` no ambiente do servidor Milhas.

O servidor Milhas chama `openWhatsApp()` em sua rota local protegida `POST /api/whatsapp/open`; o navegador usa a URL retornada para abrir o webapp. A autenticação e as verificações de origem dessa rota continuam sendo responsabilidade do servidor Milhas. O adaptador não contém chave da Evolution nem abre uma segunda sessão.
