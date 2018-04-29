async function doCancelVote(account) {
  let voteList = await app.model.Vote.findAll({ condition: { address: account.address } })
  if (voteList && voteList.length > 0 && account.weight > 0) {
    for (let voteItem of voteList) {
      app.sdb.increment('Delegate', { votes: -1 * account.weight }, { name: voteItem.delegate })
    }
  }
}

async function doCancelAgent(sender, agentAccount) {
  let cancelWeight = sender.weight
  app.sdb.increment('Account', { agentWeight: -1 * cancelWeight }, { address: agentAccount.address })
  app.sdb.update('Account', { agent: '' }, { address: sender.address })
  app.sdb.del('AgentClientele', { agent: sender.agent, clientele: sender.address })

  let voteList = await app.model.Vote.findAll({ condition: { address: agentAccount.address } })
  if (voteList && voteList.length > 0 && cancelWeight > 0) {
    for (let voteItem of voteList) {
      app.sdb.increment('Delegate', { votes: -1 * cancelWeight }, { name: voteItem.delegate })
    }
  }
}

function isUniq(arr) {
  let s = new Set
  for (let i of arr) {
    if (s.has(i)) {
      return false
    }
    s.add(i)
  }
  return true
}

module.exports = {
  transfer: async function (amount, recipient) {
    // FIXME validate recipient is valid address
    if (!recipient) return 'Invalid recipient'
    app.validate('amount', String(amount))

    // FIXME validate permission
    // FIXME validate currency
    // FIXME validate amount

    let senderId = this.trs.senderId
    amount = Number(amount)
    let sender = app.sdb.get('Account', { address: senderId })
    if ((!sender || !sender.xas || sender.xas < amount) && this.block.height > 0) return 'Insufficient balance'

    app.sdb.increment('Account', { xas: -1 * amount }, { address: senderId })

    let recipientAddress
    let recipientName = ''
    if (app.util.address.isNormalAddress(recipient)) {
      recipientAddress = recipient
    } else {
      recipientName = recipient
      let recipientAccount = await app.model.Account.findOne({ condition: { name: recipient } })
      if (!recipientAccount) return 'Recipient name not exist'
      recipientAddress = recipientAccount.address
    }

    let condition = { address: recipientAddress }
    if (!app.sdb.get('Account', condition)) {
      app.sdb.create('Account', {
        address: recipientAddress,
        xas: amount
      })
    } else {
      app.sdb.increment('Account', { xas: amount }, condition)
    }
    app.sdb.create('Transfer', {
      tid: this.trs.id,
      senderId: senderId,
      recipientId: recipientAddress,
      recipientName: recipientName,
      currency: 'XAS',
      amount: amount,
      timestamp: this.trs.timestamp
    })
  },

  setName: async function (name) {
    let reg = /^[a-z0-9_]{2,20}$/
    if (!reg.test(name)) return 'Invalid name'

    let senderId = this.trs.senderId
    app.sdb.lock('basic.account@' + senderId)

    if (this.block.height === 0) {
      app.sdb.create('Account', {
        address: senderId,
        xas: 0,
        name: name
      })
    } else {
      let exists = await app.model.Account.exists({ name: name })
      if (exists) return 'Name already registered'

      let condition = { address: senderId }
      let account = await app.model.Account.findOne({ condition: condition })
      if (account && !!account.name) return 'Name already set'

      app.sdb.update('Account', { name: name }, { address: senderId })
    }
  },

  setPassword: async function (publicKey) {
    let senderId = this.trs.senderId
    app.sdb.lock('basic.setPassword@' + senderId)
    app.sdb.update('Account', { secondPublicKey: publicKey }, { address: senderId })
  },

  lock: async function (height, amount) {
    height = Number(height)
    amount = Number(amount)
    let senderId = this.trs.senderId
    app.sdb.lock('basic.account@' + senderId)

    const MIN_LOCK_HEIGHT = 8640 * 30
    let sender = await app.model.Account.findOne({ condition: { address: senderId } })
    if (sender.isAgent) return 'Agent account cannot lock'
    if (sender.xas - 100000000 < amount) return 'Insufficient balance'
    if (sender.isLocked) {
      if (height !== 0 && height < (Math.max(this.block.height, sender.lockHeight) + MIN_LOCK_HEIGHT)) {
        return 'Invalid lock height'
      }
      if (height === 0 && amount === 0) {
        return 'Invalid height or amount'
      }
    } else {
      if (height < this.block.height + MIN_LOCK_HEIGHT) {
        return 'Invalid lock height'
      }
      if (amount === 0) {
        return 'Invalid amount'
      }
    }

    if (!sender.isLocked) {
      app.sdb.update('Account', { isLocked: 1 }, { address: senderId })
    }
    if (height !== 0) {
      app.sdb.update('Account', { lockHeight: height }, { address: senderId })
    }
    if (amount !== 0) {
      app.sdb.increment('Account', { weight: amount }, { address: senderId })
      app.sdb.increment('Account', { xas: -1 * amount }, { address: senderId })
    }

    let voteList = await app.model.Vote.findAll({ condition: { address: senderId } })
    if (voteList && voteList.length > 0 && amount > 0) {
      for (let voteItem of voteList) {
        app.sdb.increment('Delegate', { votes: amount }, { name: voteItem.delegate })
      }
    }
  },

  unlock: async function () {
    // 如果未設置代理，查詢該賬戶所投受託人，減去權重

    // 如果已經設置代理，查詢代理人所投受託人，減去代理權重
    // 自動取消代理
    let senderId = this.trs.senderId
    app.sdb.lock('basic.account@' + senderId)
    let sender = await app.model.Account.findOne({ condition: { address: senderId } })
    if (!sender) return 'Account not found'
    if (!sender.isLocked) return 'Account is not locked'
    if (this.block.height <= sender.lockHeight) return 'Account cannot unlock'

    if (!sender.agent) {
      await doCancelVote(sender)
    } else {
      let agentAccount = await app.model.Account.findOne({ condition: { name: sender.agent } })
      if (!agentAccount) return 'Agent account not found'

      await doCancelAgent(sender, agentAccount)
    }
    app.sdb.update('Account', { isLocked: 0 }, { address: senderId })
    app.sdb.update('Account', { lockHeight: 0 }, { address: senderId })
    app.sdb.increment('Account', { xas: sender.weight }, { address: senderId })
    app.sdb.update('Account', { weight: 0 }, { address: senderId })
  },

  setMultisignature: async function () {

  },

  registerAgent: async function () {
    let senderId = this.trs.senderId
    app.sdb.lock('basic.account@' + senderId)
    let account = await app.model.Account.findOne({ condition: { address: senderId } })
    if (account.isAgent) return 'Agent already registered'
    if (!account.name) return 'Agent must have a name'
    if (account.isLocked) return 'Locked account cannot be agent'

    let voteExist = await app.model.Vote.exists({ address: senderId })
    if (voteExist) return 'Account already voted'

    let isDelegate = await app.model.Delegate.exists({ address: senderId })
    if (isDelegate) return 'Delegate cannot be agent'

    app.sdb.update('Account', { isAgent: 1 }, { address: senderId })
    app.sdb.create('Agent', { name: account.name })
  },

  setAgent: async function (agent) {
    // agent不能將票權委託給其他agent
    // 有投票記錄的無法設置agent
    // 將自身權重增加到agent的weight，給agent所投人增加權重
    let senderId = this.trs.senderId
    app.sdb.lock('basic.account@' + senderId)
    let sender = await app.model.Account.findOne({ condition: { address: senderId } })
    if (sender.isAgent) return 'Agent cannot set agent'
    if (sender.agent) return 'Agent already set'
    if (!sender.isLocked) return 'Account is not locked'

    let agentAccount = await app.model.Account.findOne({ condition: { name: agent } })
    if (!agentAccount) return 'Agent account not found'
    if (!agentAccount.isAgent) return 'Not an agent'

    let voteExist = await app.model.Vote.exists({ address: senderId })
    if (voteExist) return 'Account already voted'

    app.sdb.update('Account', { agent: agent }, { address: senderId })
    app.sdb.increment('Account', { agentWeight: sender.weight }, { name: agent })

    let agentVoteList = await app.model.Vote.findAll({ condition: { address: agentAccount.address } })
    if (agentVoteList && agentVoteList.length > 0 && sender.weight > 0) {
      for (let voteItem of agentVoteList) {
        app.sdb.increment('Delegate', { votes: sender.weight }, { name: voteItem.delegate })
      }
    }
    app.sdb.create('AgentClientele', {
      agent: agent,
      clientele: senderId,
      tid: this.trs.id
    })
  },

  cancelAgent: async function () {
    // 減去agent的weight
    // 獲得agent所投的受託人列表，減去相應權重
    let senderId = this.trs.senderId
    app.sdb.lock('basic.account@' + senderId)
    let sender = await app.model.Account.findOne({ condition: { address: senderId } })
    if (!sender.agent) return 'Agent is not set'

    let agentAccount = await app.model.Account.findOne({ condition: { name: sender.agent } })
    if (!agentAccount) return 'Agent account not found'

    await doCancelAgent(sender, agentAccount)
  },

  registerDelegate: async function () {
    let senderId = this.trs.senderId
    app.sdb.lock('basic.registerDelegate@' + senderId)
    let sender
    if (this.block.height > 0) {
      sender = await app.model.Account.findOne({ condition: { address: senderId } })
      if (!sender) return 'Account not found'
      if (!sender.name) return 'Account has not a name'
      if (sender.isDelegate) return 'Account is already delegate'
      if (sender.isAgent) return 'Account cannot be delegate'
    } else {
      sender = app.sdb.get('Account', { address: senderId })
    }
    app.sdb.create('Delegate', {
      address: senderId,
      name: sender.name,
      tid: this.trs.id,
      publicKey: this.trs.senderPublicKey,
      votes: 0,
      producedBlocks: 0,
      missedBlocks: 0,
      fees: 0,
      rewards: 0
    })
    app.sdb.update('Account', { isDelegate: 1 }, { address: senderId })
  },

  vote: async function (delegates) {
    let senderId = this.trs.senderId
    app.sdb.lock('basic.account@' + senderId)

    let sender = await app.model.Account.findOne({ condition: { address: senderId } })
    if (!sender.isAgent && !sender.isLocked) return 'Account is not locked'
    if (sender.agent) return 'Account already set agent'

    delegates = delegates.split(',')
    if (!delegates || !delegates.length) return 'Invalid delegates'
    if (!isUniq(delegates)) return 'Duplicated vote item'

    let currentVotes = await app.model.Vote.findAll({ condition: { address: senderId } })
    if (currentVotes) {
      let currentVotedDelegates = new Set
      for (let v of currentVotes) {
        currentVotedDelegates.add(v.delegate)
      }
      for (let name of delegates) {
        if (currentVotedDelegates.has(name)) {
          return 'Delegate already voted: ' + name
        }
      }
    }

    for (let name of delegates) {
      if (!app.sdb.get('Delegate', { name: name })) return 'Voted delegate not exists: ' + name
    }

    for (let name of delegates) {
      app.sdb.increment('Delegate', { votes: sender.weight + sender.agentWeight }, { name: name })
      app.sdb.create('Vote', {
        address: senderId,
        delegate: name
      })
    }
  },

  unvote: async function (delegates) {
    let senderId = this.trs.senderId
    app.sdb.lock('account@' + senderId)

    let sender = await app.model.Account.findOne({ condition: { address: senderId } })
    if (!sender.isAgent && !sender.isLocked) return 'Account is not locked'
    if (sender.agent) return 'Account already set agent'

    delegates = delegates.split(',')
    if (!delegates || !delegates.length) return 'Invalid delegates'
    if (!isUniq(delegates)) return 'Duplicated vote item'

    let currentVotes = await app.model.Vote.findAll({ condition: { address: senderId } })
    if (currentVotes) {
      let currentVotedDelegates = new Set
      for (let v of currentVotes) {
        currentVotedDelegates.add(v.delegate)
      }
      for (let name of delegates) {
        if (!currentVotedDelegates.has(name)) {
          return 'Delegate not voted yet: ' + name
        }
      }
    }

    for (let name of delegates) {
      if (!app.sdb.get('Delegate', { name: name })) return 'Voted delegate not exists: ' + name
    }

    for (let name of delegates) {
      app.sdb.increment('Delegate', { votes: -1 * (sender.weight + sender.agentWeight) }, { name: name })
      app.sdb.del('Vote', { address: senderId, delegate: name })
    }
  },
}