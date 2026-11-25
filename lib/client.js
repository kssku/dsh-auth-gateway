/**
 * dsh-auth-gateway — 设置页（浏览器半）。
 *
 * 装载协议与官方 bundle 相同：window.__ModuleLoader__.load({ id, factory })。
 * 只做一件事：把 host 的配置暴露成一组表单，保存走
 * POST /api/dsh-auth-gateway/config。保存后写进 profile，重启 DSH 生效。
 */
window.__ModuleLoader__.load({
  id: 'dsh-auth-gateway',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;

    var ENDPOINT = '/api/dsh-auth-gateway/config';

    function api(op, payload) {
      var init = { method: 'GET', headers: { accept: 'application/json' } };
      if (op !== 'state') {
        init.method = 'POST';
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(Object.assign({ op: op }, payload || {}));
      }
      return fetch(ENDPOINT, init).then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw new Error((body && body.message) || ('HTTP ' + response.status));
          return body;
        });
      });
    }

    var S = {
      wrap: { maxWidth: 720, display: 'grid', gap: 18, fontSize: 13 },
      title: { fontSize: 16, fontWeight: 600, margin: 0 },
      note: { fontSize: 12, color: 'var(--dsh-text-secondary, #6b7280)', lineHeight: 1.6, margin: 0 },
      card: { border: '1px solid var(--dsh-border, #e5e7eb)', borderRadius: 10, padding: 16, display: 'grid', gap: 14 },
      row: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
      field: { display: 'grid', gap: 6 },
      label: { fontSize: 12, color: 'var(--dsh-text-secondary, #6b7280)' },
      input: { fontSize: 13, padding: '7px 9px', border: '1px solid var(--dsh-border, #d9d9d9)', borderRadius: 7, background: 'transparent', color: 'inherit', width: '100%', boxSizing: 'border-box' },
      select: { fontSize: 13, padding: '7px 9px', border: '1px solid var(--dsh-border, #d9d9d9)', borderRadius: 7, background: 'transparent', color: 'inherit', width: '100%' },
      actions: { display: 'flex', alignItems: 'center', gap: 10 },
      button: { fontSize: 13, padding: '7px 16px', borderRadius: 7, border: '1px solid var(--dsh-border, #d9d9d9)', background: 'var(--dsh-bg-hover, #f5f5f5)', color: 'inherit', cursor: 'pointer' },
      ok: { fontSize: 12, color: 'var(--dsh-success, #15803d)' },
      bad: { fontSize: 12, color: 'var(--dsh-danger, #b91c1c)' },
      hint: { fontSize: 12, color: 'var(--dsh-text-secondary, #6b7280)' },
      stat: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, fontSize: 12 },
      statCell: { border: '1px solid var(--dsh-border, #e5e7eb)', borderRadius: 8, padding: '8px 10px' },
      statKey: { color: 'var(--dsh-text-secondary, #6b7280)', display: 'block', marginBottom: 2 },
    };

    function Field(props) {
      return h('label', { style: S.field },
        h('span', { style: S.label }, props.label),
        props.children,
        props.hint ? h('span', { style: S.hint }, props.hint) : null,
      );
    }

    function Text(props) {
      return h('input', {
        style: S.input, type: props.type || 'text', value: props.value,
        placeholder: props.placeholder || '', disabled: props.disabled,
        onChange: function (event) { props.onChange(event.target.value); },
      });
    }

    function GatewaySection() {
      var stateBox = React.useState(null);
      var state = stateBox[0];
      var setState = stateBox[1];
      var draftBox = React.useState(null);
      var draft = draftBox[0];
      var setDraft = draftBox[1];
      var busyBox = React.useState(false);
      var busy = busyBox[0];
      var setBusy = busyBox[1];
      var msgBox = React.useState(null);
      var msg = msgBox[0];
      var setMsg = msgBox[1];

      React.useEffect(function () {
        api('state').then(function (payload) {
          setState(payload);
          setDraft(payload.config);
        }).catch(function (error) { setMsg({ bad: true, text: String(error.message || error) }); });
      }, []);

      function set(key, value) {
        setDraft(function (current) {
          var next = Object.assign({}, current);
          next[key] = value;
          return next;
        });
      }
      function setAuth(patch) {
        setDraft(function (current) {
          var next = Object.assign({}, current);
          next.auth = Object.assign({}, current.auth, patch);
          return next;
        });
      }
      function setBasic(patch) {
        setDraft(function (current) {
          var next = Object.assign({}, current);
          next.auth = Object.assign({}, current.auth, { basic: Object.assign({}, current.auth.basic, patch) });
          return next;
        });
      }
      function setHeader(patch) {
        setDraft(function (current) {
          var next = Object.assign({}, current);
          next.auth = Object.assign({}, current.auth, { header: Object.assign({}, current.auth.header, patch) });
          return next;
        });
      }
      function setCustom(patch) {
        setDraft(function (current) {
          var next = Object.assign({}, current);
          next.auth = Object.assign({}, current.auth, { custom: Object.assign({}, current.auth.custom, patch) });
          return next;
        });
      }

      function save() {
        setBusy(true); setMsg(null);
        api('save', { config: draft }).then(function (payload) {
          setState(function (current) { return Object.assign({}, current, { config: payload.config, status: payload.status || current.status }); });
          setDraft(payload.config);
          setMsg({ ok: true, text: payload.restartRequired ? '已写入 profile。端口/监听地址的改动需要重启 DSH 生效。' : '已保存。' });
        }).catch(function (error) {
          setMsg({ bad: true, text: String(error.message || error) });
        }).finally(function () { setBusy(false); });
      }

      if (!draft) {
        return h('div', { style: S.wrap }, h('h2', { style: S.title }, '免认证网关'),
          h('p', { style: S.note }, state ? '正在读取配置…' : '加载中…'),
          msg ? h('p', { style: msg.bad ? S.bad : S.ok }, msg.text) : null);
      }

      var status = (state && state.status) || {};
      var mode = draft.auth.mode;
      var enabled = draft.enabled !== false;

      return h('div', { style: S.wrap },
        h('div', null,
          h('h2', { style: S.title }, '免认证网关'),
          h('p', { style: S.note }, '这个网关在独立端口上反向代理 DSH：它自己持有有效会话并注入每个请求，所以浏览器不需要 token 或 cookie。默认模式不做任何认证 —— 能访问这个端口的人就拿到了完整控制权。'),
        ),
        h('div', { style: S.stat },
          h('div', { style: S.statCell }, h('span', { style: S.statKey }, '监听'), h('b', null, status.listening || (enabled ? '未启动' : '已关闭'))),
          h('div', { style: S.statCell }, h('span', { style: S.statKey }, '上游'), h('b', null, status.target || (draft.targetHost + ':' + draft.targetPort))),
          h('div', { style: S.statCell }, h('span', { style: S.statKey }, '会话'), h('b', null, status.session ? '已建立' : '无')),
          h('div', { style: S.statCell }, h('span', { style: S.statKey }, '请求 / 升级'), h('b', null, (status.requests || 0) + ' / ' + (status.upgrades || 0))),
        ),

        h('div', { style: S.card },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('input', { type: 'checkbox', checked: enabled, onChange: function (event) { set('enabled', event.target.checked); } }),
            h('span', null, '启用网关'),
          ),
          h('div', { style: S.row },
            h(Field, { label: '监听地址', hint: '局域网访问填 0.0.0.0；只给本机用就留 127.0.0.1' }, h(Text, { value: draft.host, onChange: function (v) { set('host', v); } })),
            h(Field, { label: '监听端口' }, h(Text, { value: String(draft.port), onChange: function (v) { set('port', Number(v) || 0); } })),
          ),
          h('div', { style: S.row },
            h(Field, { label: '上游地址' }, h(Text, { value: draft.targetHost, onChange: function (v) { set('targetHost', v); } })),
            h(Field, { label: '上游端口' }, h(Text, { value: String(draft.targetPort), onChange: function (v) { set('targetPort', Number(v) || 0); } })),
          ),
        ),

        h('div', { style: S.card },
          h(Field, { label: '认证模式', hint: '默认 none：不认证直接放行。其余模式只影响谁能穿过网关。' },
            h('select', { style: S.select, value: mode, disabled: !enabled, onChange: function (event) { setAuth({ mode: event.target.value }); } },
              h('option', { value: 'none' }, 'none —— 不认证'),
              h('option', { value: 'basic' }, 'basic —— 用户名 / 密码'),
              h('option', { value: 'header' }, 'header —— 自定义请求头'),
              h('option', { value: 'custom' }, 'custom —— 自己的认证模块'),
            )),
          mode === 'basic' ? h('div', { style: S.row },
            h(Field, { label: '用户名' }, h(Text, { value: draft.auth.basic.username, onChange: function (v) { setBasic({ username: v }); } })),
            h(Field, { label: '密码', hint: draft.auth.basic.hasPassword ? '已设置；留空表示不修改' : '' }, h(Text, { type: 'password', value: draft.auth.basic.password || '', onChange: function (v) { setBasic({ password: v }); } })),
          ) : null,
          mode === 'header' ? h('div', { style: S.row },
            h(Field, { label: '请求头名' }, h(Text, { value: draft.auth.header.name, onChange: function (v) { setHeader({ name: v }); } })),
            h(Field, { label: '请求头值', hint: draft.auth.header.hasValue ? '已设置；留空表示不修改' : '' }, h(Text, { type: 'password', value: draft.auth.header.value || '', onChange: function (v) { setHeader({ value: v }); } })),
          ) : null,
          mode === 'custom' ? h(Field, { label: '认证模块路径', hint: '导出 authenticate(req) → boolean | Promise<boolean>；拒绝返回 401。' },
            h(Text, { value: draft.auth.custom.module, placeholder: '/srv/me/my-auth.mjs', onChange: function (v) { setCustom({ module: v }); } })) : null,
        ),

        h('div', { style: S.card },
          h(Field, { label: '会话缓存文件', hint: '换到一次 cookie 后落盘，重启直接复用；留空则禁用缓存。' },
            h(Text, { value: draft.cookieCache, onChange: function (v) { set('cookieCache', v); } })),
        ),

        h('div', { style: S.actions },
          h('button', { type: 'button', style: S.button, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          h('span', { style: S.hint }, '保存写入当前 profile 的 patch；监听地址/端口改动需重启 DSH。'),
        ),
        msg ? h('p', { style: msg.bad ? S.bad : S.ok }, msg.text) : null,
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'auth-gateway',
          order: 60,
          label: function () { return '免认证网关'; },
          inject: function () { return {}; },
        }, GatewaySection);
      });
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
