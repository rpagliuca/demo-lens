Vamos fazer um webapp dinâmico espelhado no Google Lens usando como base a API de modelos de IA <https://ms-ai-services.public.homologation.lb1.yes.network/>

Não tem autenticação ali. Queremos usar Node/HTML/JS/CSS.

A latência de detecção de SKU e Qualidade de eltrodomésticos pode demorar vários segundos, e não podemos mandar uma requisição para o servidor enquanto já tem outra em andamento. Uma ideia é deixar a câmera sendo exibida continuamente, mas quando já tiver um request, deixar a tela um pouco mais escura (acho que já vi essa UX em outros lugares, para o usuário continuar enxergando a câmera, mas perceber que tem algo rolando por trás por estar mais escuro, e pode ter alguma mensagem dizendo que está aguardando resposta).

A ideia é ser muito dinâmico, ter uma experiência "smooth"/seamless, sem o usuário ter que ativamente clicar no botão de foto.

Se possível, usar algum modelo de visão computacional MUITO LEVE via JAVASCRIPT que identifica se a foto não está borrada, se o frame tem uma qualidade razoável, etc, antes de tentar enviar o frame para o backend

Pode usar ReactJS ou outro framework mais moderno só se for devidamente justificável. Node é bom para termos hotreload, e também possivelmente queremos ter algum tipo de parseamento da resposta (como um backend for frontend). Mas fica a seu critério.
